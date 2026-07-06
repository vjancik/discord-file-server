import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "@/db/client";
import { createTestDb, insertTestUser, testFileRow } from "@/test/db";
import { FileRepository } from "../files/file.repository";
import { FileService } from "../files/file.service";
import { FileStorage } from "../files/storage";
import { deleteExpiredFiles } from "./expiry";
import { collectStagingGarbage } from "./staging-gc";

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
