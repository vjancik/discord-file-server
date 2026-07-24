import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StagingLedger } from "./staging-ledger";
import { rebuildLedger, reconcileLedger, scanStaging } from "./staging-scan";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "staging-scan-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function writeUpload(id: string, sizeBytes: number, ownerId?: string) {
  await Bun.write(path.join(tmp, id), "x".repeat(Math.min(sizeBytes, 8)));
  await Bun.write(
    path.join(tmp, `${id}.json`),
    JSON.stringify({ id, size: sizeBytes, offset: 0, metadata: { ownerId } }),
  );
}

describe("scanStaging", () => {
  test("pairs data files with sidecars and reads declared size + owner", async () => {
    await writeUpload("u1", 5000, "alice");

    const scan = await scanStaging(tmp);

    expect(scan.uploads).toHaveLength(1);
    expect(scan.uploads[0]).toMatchObject({
      id: "u1",
      sizeBytes: 5000,
      ownerId: "alice",
      bytesOnDisk: 8,
    });
    expect(scan.orphans).toHaveLength(0);
  });

  test("classifies unpaired files as orphans and totals their bytes", async () => {
    await Bun.write(path.join(tmp, "leftover-data"), "abcdef"); // no sidecar
    await Bun.write(path.join(tmp, "ghost.json"), JSON.stringify({ size: 10 })); // no data file

    const scan = await scanStaging(tmp);

    expect(scan.uploads).toHaveLength(0);
    expect(scan.orphans).toHaveLength(2);
    expect(scan.orphanBytes).toBeGreaterThanOrEqual(6);
  });

  test("pairs an extension-carrying data file with its sidecar", async () => {
    // tus now names the staging file <id>.<ext>; its sidecar is <id>.<ext>.json.
    await writeUpload("9f8a7c.jpg", 5000, "alice");

    const scan = await scanStaging(tmp);

    expect(scan.uploads).toHaveLength(1);
    expect(scan.uploads[0]).toMatchObject({
      id: "9f8a7c.jpg",
      ownerId: "alice",
    });
    expect(scan.orphans).toHaveLength(0);
  });

  test("a .json-extensioned upload is a data file, not a sidecar", async () => {
    // Uploading notes.json → data file <id>.json, sidecar <id>.json.json.
    // The data file must never be mistaken for a sidecar and orphaned.
    await writeUpload("7c6b.json", 3000, "bob");

    const scan = await scanStaging(tmp);

    expect(scan.uploads).toHaveLength(1);
    expect(scan.uploads[0]).toMatchObject({ id: "7c6b.json", sizeBytes: 3000 });
    expect(scan.orphans).toHaveLength(0);
  });

  test("skips pairs whose sidecar cannot be parsed (may be mid-write)", async () => {
    await Bun.write(path.join(tmp, "u2"), "data");
    await Bun.write(path.join(tmp, "u2.json"), "{not json");

    const scan = await scanStaging(tmp);

    expect(scan.uploads).toHaveLength(0);
    expect(scan.orphans).toHaveLength(0);
  });

  test("tolerates a missing staging dir", async () => {
    const scan = await scanStaging(path.join(tmp, "nope"));
    expect(scan.uploads).toHaveLength(0);
    expect(scan.bytesOnDisk).toBe(0);
  });
});

describe("ledger rebuild & reconcile", () => {
  test("rebuild reserves every scanned upload at its declared size", async () => {
    await writeUpload("u1", 1000, "alice");
    await writeUpload("u2", 2000, "bob");
    const ledger = new StagingLedger();
    ledger.reserve("stale", 999, "ghost"); // pre-restart junk

    const restored = rebuildLedger(await scanStaging(tmp), ledger);

    expect(restored).toBe(2);
    expect(ledger.count).toBe(2);
    expect(ledger.totalReserved()).toBe(3000);
    expect(ledger.has("stale")).toBe(false);
  });

  test("reconcile releases reservations without files and adopts unledgered uploads", async () => {
    await writeUpload("on-disk", 500, "alice");
    const ledger = new StagingLedger();
    ledger.reserve("leaked", 800, "bob"); // file long gone

    const drift = reconcileLedger(await scanStaging(tmp), ledger);

    expect(drift).toEqual({ added: 1, released: 1 });
    expect(ledger.has("on-disk")).toBe(true);
    expect(ledger.has("leaked")).toBe(false);
  });
});
