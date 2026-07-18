import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { evictStagingUnderPressure } from "../cleanup/staging-gc";
import { AdmissionService } from "./admission.service";
import type { DiskProbe } from "./disk";
import { StagingLedger } from "./staging-ledger";

let tmp: string;
let stagingDir: string;
let storageDir: string;
let ledger: StagingLedger;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "admission-test-"));
  stagingDir = path.join(tmp, "staging");
  storageDir = path.join(tmp, "storage");
  mkdirSync(stagingDir);
  mkdirSync(storageDir);
  ledger = new StagingLedger();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Plenty of physical space unless a test says otherwise. */
class FakeDisk implements DiskProbe {
  constructor(private readonly free: Record<string, number>) {}
  async freeBytes(dir: string): Promise<number> {
    return this.free[dir] ?? Number.MAX_SAFE_INTEGER;
  }
}

interface ServiceOpts {
  stagingLimit?: number;
  storageLimit?: number;
  liveBytes?: number;
  free?: Record<string, number>;
  evict?: (needed: number) => Promise<unknown>;
}

function service(opts: ServiceOpts = {}) {
  const evictions: number[] = [];
  const svc = new AdmissionService(
    ledger,
    new FakeDisk(opts.free ?? {}),
    { totalLiveBytes: () => opts.liveBytes ?? 0 },
    {
      stagingDir,
      storageDir,
      stagingLimit: opts.stagingLimit ?? 1000,
      storageLimit: opts.storageLimit ?? 100_000,
      headroomBytes: 0,
    },
    opts.evict ??
      (async (needed) => {
        evictions.push(needed);
      }),
  );
  return { svc, evictions };
}

async function writeStagedUpload(id: string, sizeBytes: number, ageMs = 0) {
  const dataPath = path.join(stagingDir, id);
  const sidecarPath = path.join(stagingDir, `${id}.json`);
  await Bun.write(dataPath, "x".repeat(Math.min(sizeBytes, 16)));
  await Bun.write(sidecarPath, JSON.stringify({ id, size: sizeBytes }));
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(dataPath, then, then);
    utimesSync(sidecarPath, then, then);
  }
}

describe("staging decisions", () => {
  test("accepts when reservation + upload fit the limit", async () => {
    ledger.reserve("other", 400, "bob");
    const { svc, evictions } = service({ stagingLimit: 1000 });

    const decision = await svc.admit({ ownerId: "alice", sizeBytes: 500 });

    expect(decision).toEqual({ action: "accept" });
    expect(evictions).toHaveLength(0);
  });

  test("rejects a file larger than staging can ever hold, without evicting", async () => {
    const { svc, evictions } = service({ stagingLimit: 1000 });

    const decision = await svc.admit({ ownerId: "alice", sizeBytes: 1500 });

    expect(decision.action).toBe("reject");
    expect(evictions).toHaveLength(0);
  });

  test("physical free space clips the configured limit", async () => {
    // Volume can only absorb 100 more bytes → a 300-byte file can never fit.
    const { svc } = service({
      stagingLimit: 1000,
      free: { [stagingDir]: 100 },
    });

    const decision = await svc.admit({ ownerId: "alice", sizeBytes: 300 });

    expect(decision.action).toBe("reject");
  });

  test("tells the upload to wait when full but other uploads are draining", async () => {
    ledger.reserve("big", 800, "bob");
    const { svc, evictions } = service({ stagingLimit: 1000 });

    const decision = await svc.admit({ ownerId: "alice", sizeBytes: 300 });

    expect(decision.action).toBe("wait");
    expect(evictions).toEqual([100]); // tried eager cleanup first
  });

  test("rejects when full and nothing is draining (waiting cannot help)", async () => {
    // Dead orphan bytes fill staging; no ledger entries → nothing will drain.
    await Bun.write(path.join(stagingDir, "orphan"), "x".repeat(16));
    const { svc } = service({
      stagingLimit: 10,
      evict: async () => {}, // eviction finds nothing it may remove
    });

    const decision = await svc.admit({ ownerId: "alice", sizeBytes: 5 });

    expect(decision.action).toBe("reject");
    if (decision.action === "reject") {
      expect(decision.reason).toContain("no active uploads");
    }
  });

  test("accepts after real pressure eviction clears orphans", async () => {
    // 16 orphan bytes block a 5-byte upload against a 10-byte limit; the
    // orphan is old enough to evict, so admission recovers on re-measure.
    const orphanPath = path.join(stagingDir, "orphan");
    await Bun.write(orphanPath, "x".repeat(16));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(orphanPath, old, old);
    const { svc } = service({
      stagingLimit: 10,
      evict: (needed) => evictStagingUnderPressure(stagingDir, ledger, needed),
    });

    const decision = await svc.admit({ ownerId: "alice", sizeBytes: 5 });

    expect(decision).toEqual({ action: "accept" });
  });

  test("counts unledgered staged uploads at their declared size", async () => {
    await writeStagedUpload("unledgered", 900);
    const { svc } = service({ stagingLimit: 1000 });

    const decision = await svc.admit({ ownerId: "alice", sizeBytes: 300 });

    // 900 declared + 300 > 1000, nothing in the ledger → reject.
    expect(decision.action).toBe("reject");
  });
});

describe("storage decisions", () => {
  test("rejects when live + in-flight + upload exceed the storage budget", async () => {
    ledger.reserve("inflight", 300, "bob");
    const { svc } = service({ storageLimit: 1000, liveBytes: 500 });

    const decision = await svc.admit({ ownerId: "alice", sizeBytes: 300 });

    expect(decision.action).toBe("reject");
    if (decision.action === "reject") {
      expect(decision.reason).toContain("storage budget");
    }
  });

  test("credits bytes the quota plan will auto-delete", async () => {
    ledger.reserve("inflight", 300, "bob");
    const { svc } = service({ storageLimit: 1000, liveBytes: 500 });

    const decision = await svc.admit({
      ownerId: "alice",
      sizeBytes: 300,
      bytesFreedByPlan: 200,
    });

    expect(decision).toEqual({ action: "accept" });
  });

  test("rejects when the storage volume is physically full", async () => {
    const { svc } = service({ free: { [storageDir]: 100 } });

    const decision = await svc.admit({ ownerId: "alice", sizeBytes: 300 });

    expect(decision.action).toBe("reject");
    if (decision.action === "reject") {
      expect(decision.reason).toContain("disk space");
    }
  });
});
