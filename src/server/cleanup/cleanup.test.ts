import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "@/db/client";
import { StagingLedger } from "@/server/capacity/staging-ledger";
import { createTestDb, insertTestUser, testFileRow } from "@/test/db";
import { FileRepository } from "../files/file.repository";
import { FileService } from "../files/file.service";
import { FileStorage } from "../files/storage";
import { deleteExpiredFiles } from "./expiry";
import {
  collectStagingGarbage,
  evictStagingUnderPressure,
  PRESSURE_IDLE_TTL_MS,
} from "./staging-gc";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("collectStagingGarbage", () => {
  test("removes files older than the TTL, keeps fresh ones", async () => {
    const stale = path.join(tmp, "old-upload");
    const staleInfo = path.join(tmp, "old-upload.json");
    const fresh = path.join(tmp, "active-upload");
    await Bun.write(stale, "x");
    await Bun.write(staleInfo, "{}");
    await Bun.write(fresh, "y");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);
    utimesSync(staleInfo, twoDaysAgo, twoDaysAgo);

    const removed = await collectStagingGarbage(tmp);

    expect(removed).toBe(2);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(staleInfo)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("tolerates a missing staging dir", async () => {
    expect(await collectStagingGarbage(path.join(tmp, "nope"))).toBe(0);
  });

  test("keeps a pair whose sidecar is old but data file is active", async () => {
    // The sidecar is written once at creation and never touched again; only
    // the newest mtime of the pair may decide staleness, or a >24h upload
    // loses its sidecar mid-flight.
    const data = path.join(tmp, "long-upload");
    const sidecar = path.join(tmp, "long-upload.json");
    await Bun.write(data, "chunk");
    await Bun.write(sidecar, JSON.stringify({ size: 100 }));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    utimesSync(sidecar, twoDaysAgo, twoDaysAgo); // data mtime stays fresh

    expect(await collectStagingGarbage(tmp)).toBe(0);
    expect(existsSync(sidecar)).toBe(true);
  });

  test("releases the ledger reservation of a collected upload", async () => {
    const data = path.join(tmp, "dead");
    const sidecar = path.join(tmp, "dead.json");
    await Bun.write(data, "x");
    await Bun.write(sidecar, JSON.stringify({ size: 100 }));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    utimesSync(data, twoDaysAgo, twoDaysAgo);
    utimesSync(sidecar, twoDaysAgo, twoDaysAgo);
    const ledger = new StagingLedger();
    ledger.reserve("dead", 100, "alice");

    await collectStagingGarbage(tmp, ledger);

    expect(ledger.has("dead")).toBe(false);
  });
});

describe("evictStagingUnderPressure", () => {
  const age = (filePath: string, ms: number) => {
    const then = new Date(Date.now() - ms);
    utimesSync(filePath, then, then);
  };

  test("tier 1: removes orphans past the grace period, keeps fresh ones", async () => {
    const oldOrphan = path.join(tmp, "old-orphan");
    const freshOrphan = path.join(tmp, "fresh-orphan");
    await Bun.write(oldOrphan, "12345");
    await Bun.write(freshOrphan, "12345");
    age(oldOrphan, 5 * 60 * 1000);

    const result = await evictStagingUnderPressure(tmp, new StagingLedger(), 1);

    expect(result.removedOrphans).toBe(1);
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(freshOrphan)).toBe(true);
  });

  test("tier 2: evicts idle uploads oldest-first, only as many as needed", async () => {
    const ledger = new StagingLedger();
    for (const [id, idleMs] of [
      ["oldest", PRESSURE_IDLE_TTL_MS * 3],
      ["idle", PRESSURE_IDLE_TTL_MS * 2],
      ["active", 0],
    ] as const) {
      const data = path.join(tmp, id);
      const sidecar = path.join(tmp, `${id}.json`);
      await Bun.write(data, "x");
      await Bun.write(sidecar, JSON.stringify({ id, size: 500 }));
      if (idleMs > 0) {
        age(data, idleMs);
        age(sidecar, idleMs);
      }
      ledger.reserve(id, 500, "alice");
    }

    // Needing 400 logical bytes: evicting "oldest" frees its full 500-byte
    // reservation, so "idle" survives and "active" is never touched.
    const result = await evictStagingUnderPressure(tmp, ledger, 400);

    expect(result.evictedUploads).toBe(1);
    expect(existsSync(path.join(tmp, "oldest"))).toBe(false);
    expect(ledger.has("oldest")).toBe(false);
    expect(existsSync(path.join(tmp, "idle"))).toBe(true);
    expect(ledger.has("idle")).toBe(true);
    expect(existsSync(path.join(tmp, "active"))).toBe(true);
  });

  test("never evicts fresh in-flight uploads even when short on space", async () => {
    const ledger = new StagingLedger();
    await Bun.write(path.join(tmp, "active"), "x");
    await Bun.write(
      path.join(tmp, "active.json"),
      JSON.stringify({ size: 500 }),
    );
    ledger.reserve("active", 500, "alice");

    const result = await evictStagingUnderPressure(tmp, ledger, 10_000);

    expect(result.evictedUploads).toBe(0);
    expect(existsSync(path.join(tmp, "active"))).toBe(true);
  });
});

describe("deleteExpiredFiles", () => {
  let db: Db;
  let cleanup: () => void;

  afterEach(() => cleanup());

  test("tombstones expired files with a null actor and removes bytes", async () => {
    ({ db, cleanup } = createTestDb());
    const repo = new FileRepository(db);
    const storage = new FileStorage(tmp);
    const files = new FileService(repo, storage);
    const owner = insertTestUser(db);

    const expired = repo.insert(
      testFileRow(owner, { expiresAt: new Date(Date.now() - 1000) }),
    );
    const alive = repo.insert(
      testFileRow(owner, { expiresAt: new Date(Date.now() + 60_000) }),
    );
    await Bun.write(storage.pathFor(expired.id, "clip.mp4"), "bytes");

    const count = await deleteExpiredFiles(repo, files);

    expect(count).toBe(1);
    expect(repo.findLiveById(expired.id)).toBeUndefined();
    expect(repo.findById(expired.id)?.deletedById).toBeNull();
    expect(existsSync(storage.dirFor(expired.id))).toBe(false);
    expect(repo.findLiveById(alive.id)).toBeDefined();
  });
});
