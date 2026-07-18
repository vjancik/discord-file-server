import { createLogger } from "@/lib/logger";
import { formatBytes } from "@/lib/units";
import { DISK_HEADROOM_BYTES, type DiskProbe } from "./disk";
import type { StagingLedger } from "./staging-ledger";
import { scanStaging } from "./staging-scan";

const log = createLogger("admission");

export interface AdmissionConfig {
  stagingDir: string;
  storageDir: string;
  /** STAGING_LIMIT: byte budget for in-progress uploads (full sizes, reserved up front). */
  stagingLimit: number;
  /** STORAGE_LIMIT: byte budget for completed files. */
  storageLimit: number;
  headroomBytes?: number;
}

/**
 * `wait` maps to HTTP 429 — the tus client retries automatically, which is
 * our queue: no FIFO, deliberately. Small files are the primary use case and
 * must never wait behind a queued large file, so anything that fits is
 * admitted immediately even while a large upload is waiting. The cost is
 * that a waiting large upload can starve and eventually fail; accepted.
 * `reject` maps to a non-429 4xx so the client fails fast with the reason.
 */
export type AdmissionDecision =
  | { action: "accept" }
  | { action: "wait"; reason: string }
  | { action: "reject"; reason: string };

/** Frees staging space under pressure; see evictStagingUnderPressure. */
export type PressureEvictor = (neededBytes: number) => Promise<unknown>;

interface StagingMeasurement {
  /** min(configured limit, what the volume can physically still absorb). */
  effectiveLimit: number;
  /** Reserved in-flight bytes + dead bytes (orphans, unledgered leftovers). */
  used: number;
}

/**
 * Capacity gate for upload creation. Everything here is bookkeeping over the
 * single-process ledger plus a physical statfs check — the quota service
 * answers "may this user store this?", admission answers "can the disks
 * take it right now?".
 */
export class AdmissionService {
  private warnedStagingClip = false;
  private warnedStorageClip = false;

  constructor(
    private readonly ledger: StagingLedger,
    private readonly disk: DiskProbe,
    private readonly files: { totalLiveBytes(): number },
    private readonly config: AdmissionConfig,
    private readonly evict: PressureEvictor,
  ) {}

  private get headroom(): number {
    return this.config.headroomBytes ?? DISK_HEADROOM_BYTES;
  }

  /**
   * @param bytesFreedByPlan storage bytes the quota plan will free via
   * auto-delete if we accept. The deletions only run on accept, so they are
   * credited here rather than already applied.
   */
  async admit(input: {
    ownerId: string;
    sizeBytes: number;
    bytesFreedByPlan?: number;
  }): Promise<AdmissionDecision> {
    const { ownerId, sizeBytes, bytesFreedByPlan = 0 } = input;

    // Storage first: staging drains *into* storage, so waiting never helps a
    // full storage volume — that is always an immediate reject.
    const storageProblem = await this.checkStorage(sizeBytes, bytesFreedByPlan);
    if (storageProblem) {
      log.error(
        { ownerId, sizeBytes, reason: storageProblem.reason },
        "upload rejected: storage capacity",
      );
      return storageProblem;
    }

    let staging = await this.measureStaging();

    // Larger than staging can hold even when empty — can never fit.
    if (sizeBytes > staging.effectiveLimit) {
      const reason = `File is too large (${formatBytes(sizeBytes)}) for the server's staging area (${formatBytes(staging.effectiveLimit)} max).`;
      log.error(
        { ownerId, sizeBytes, reason },
        "upload rejected: staging capacity",
      );
      return { action: "reject", reason };
    }

    if (staging.used + sizeBytes <= staging.effectiveLimit) {
      return { action: "accept" };
    }

    // Under pressure: eagerly clear dead/abandoned entries, then re-measure
    // from disk rather than trusting the evictor's arithmetic.
    await this.evict(staging.used + sizeBytes - staging.effectiveLimit);
    staging = await this.measureStaging();
    if (staging.used + sizeBytes <= staging.effectiveLimit) {
      return { action: "accept" };
    }

    if (this.ledger.count > 0) {
      // Active uploads will drain to storage (or hit the idle-eviction TTL),
      // so space is coming: tell the client to retry (429).
      log.warn(
        { ownerId, sizeBytes, inFlight: this.ledger.count },
        "staging full; upload told to wait for in-flight uploads to drain",
      );
      return {
        action: "wait",
        reason: `The server is busy (${this.ledger.count} upload(s) in progress). Your upload will start automatically when space frees up.`,
      };
    }

    // Nothing in flight and eviction found nothing to free: waiting cannot
    // help, so fail now instead of letting the client spin (user decision).
    const reason = `Not enough staging space for this upload (${formatBytes(sizeBytes)} needed, ${formatBytes(Math.max(0, staging.effectiveLimit - staging.used))} available) and no active uploads are freeing space.`;
    log.error(
      { ownerId, sizeBytes, reason },
      "upload rejected: staging full with nothing draining",
    );
    return { action: "reject", reason };
  }

  private async measureStaging(): Promise<StagingMeasurement> {
    const scan = await scanStaging(this.config.stagingDir);
    const physicalFree = await this.disk.freeBytes(this.config.stagingDir);

    // The volume can absorb what's already there plus its free space. If the
    // configured limit exceeds that, clip to physical reality and warn —
    // someone else is using the disk, or the limit was oversized. (Caveat:
    // treats staging bytes as reclaimable, which assumes storage lives on a
    // different volume — the PRD deployment layout.)
    const physicalCeiling = scan.bytesOnDisk + physicalFree - this.headroom;
    const effectiveLimit = Math.min(this.config.stagingLimit, physicalCeiling);
    this.warnedStagingClip = warnOnClip(
      "staging",
      this.config.stagingLimit,
      physicalCeiling,
      this.warnedStagingClip,
    );

    // Reservations count at full declared size (their partial bytes on disk
    // live inside the reservation — never add both). Orphans and unledgered
    // leftovers count at their disk size.
    let used = this.ledger.totalReserved() + scan.orphanBytes;
    for (const upload of scan.uploads) {
      if (!this.ledger.has(upload.id)) {
        used += Math.max(upload.sizeBytes, upload.bytesOnDisk);
      }
    }
    return { effectiveLimit, used };
  }

  private async checkStorage(
    sizeBytes: number,
    bytesFreedByPlan: number,
  ): Promise<{ action: "reject"; reason: string } | undefined> {
    // Everything reserved in staging will land in storage too.
    const inbound = this.ledger.totalReserved() + sizeBytes;

    // Bookkeeping: global backstop behind the per-user quota checks, which
    // can drift past STORAGE_LIMIT when the active-user divisor shrinks.
    const committed = this.files.totalLiveBytes() - bytesFreedByPlan + inbound;
    if (committed > this.config.storageLimit) {
      return {
        action: "reject",
        reason: `The server's storage budget is exhausted (${formatBytes(this.config.storageLimit)}). Try again after old files are deleted.`,
      };
    }

    // Physical: the volume must absorb every in-flight byte plus this one.
    const physicalFree = await this.disk.freeBytes(this.config.storageDir);
    const usable = physicalFree + bytesFreedByPlan - this.headroom;
    this.warnedStorageClip = warnOnClip(
      "storage",
      this.config.storageLimit - this.files.totalLiveBytes(),
      usable,
      this.warnedStorageClip,
    );
    if (inbound > usable) {
      return {
        action: "reject",
        reason:
          "The server's storage volume is out of disk space. Try again after files are cleaned up.",
      };
    }
    return undefined;
  }
}

/**
 * Logs (once per transition, not per admission — waits retry every few
 * seconds) when bookkeeping expects more room than the volume physically
 * has. The caller clips to the physical number rather than failing eagerly.
 */
function warnOnClip(
  volume: string,
  expected: number,
  physical: number,
  alreadyWarned: boolean,
): boolean {
  const clipped = physical < expected;
  if (clipped && !alreadyWarned) {
    log.warn(
      {
        volume,
        expectedFreeBytes: expected,
        physicalFreeBytes: physical,
      },
      "configured capacity exceeds physical free space; clipping to physical",
    );
  }
  return clipped;
}
