import { unlink } from "node:fs/promises";
import { createLogger } from "@/lib/logger";
import type { StagingLedger } from "@/server/capacity/staging-ledger";
import {
  type ScannedUpload,
  scanStaging,
} from "@/server/capacity/staging-scan";

const log = createLogger("staging-gc");

/** Default TTL for abandoned partial uploads: 24 h (PRD open item — sensible default). */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Pressure eviction only touches uploads idle for at least this long. Policy
 * call: within-session resumability (pause, network blip) is worth
 * protecting; a partial upload untouched for an hour while space is needed
 * is presumed abandoned. Evicting it breaks that client's resume (its next
 * PATCH 404s and the upload restarts) — accepted, logged as a warning.
 */
export const PRESSURE_IDLE_TTL_MS = 60 * 60 * 1000;

/**
 * Never evict anything younger than this, even orphans. Insurance against
 * misclassifying an entry raced mid-creation.
 */
const EVICTION_GRACE_MS = 60 * 1000;

/**
 * Deletes stale in-progress tus uploads whose newest mtime (data file or
 * sidecar) is older than the TTL, releasing their ledger reservations.
 * Pair-aware on purpose: the sidecar is written once at creation and never
 * touched again, so judging it by its own mtime would delete the sidecar out
 * from under a long-running active upload. A parked resumable upload writes
 * the data file on every chunk, so a pair untouched for a day is abandoned.
 */
export async function collectStagingGarbage(
  stagingDir: string,
  ledger?: StagingLedger,
  ttlMs: number = STAGING_TTL_MS,
  now: number = Date.now(),
): Promise<number> {
  const scan = await scanStaging(stagingDir);
  let removed = 0;

  for (const upload of scan.uploads) {
    if (now - upload.mtimeMs < ttlMs) continue;
    removed += await removeUpload(upload, ledger);
  }
  for (const orphan of scan.orphans) {
    if (now - orphan.mtimeMs < ttlMs) continue;
    if (await unlinkSafe(orphan.filePath)) removed++;
  }

  if (removed > 0) log.info({ removed }, "removed stale staging uploads");
  return removed;
}

export interface EvictionResult {
  /** Logical staging bytes freed: orphan disk bytes + full reserved sizes of evicted uploads. */
  freedBytes: number;
  removedOrphans: number;
  evictedUploads: number;
}

/**
 * Eager cleanup when admission runs out of staging space, in two tiers:
 *
 * 1. Orphans (unresumable leftovers — see staging-scan.ts) go first at any
 *    age past a short grace period: they are dead bytes that would otherwise
 *    sit until the 24 h GC.
 * 2. If still short, in-flight uploads idle longer than
 *    PRESSURE_IDLE_TTL_MS are evicted oldest-first, breaking their resume
 *    (trade-off documented on the constant). Fresh uploads are never touched
 *    — anything mid-finalize just wrote its last chunk and looks fresh.
 *
 * Stops as soon as `neededBytes` of logical space is freed. The caller
 * re-measures afterwards rather than trusting this arithmetic.
 */
export async function evictStagingUnderPressure(
  stagingDir: string,
  ledger: StagingLedger,
  neededBytes: number,
  now: number = Date.now(),
): Promise<EvictionResult> {
  const scan = await scanStaging(stagingDir);
  const result: EvictionResult = {
    freedBytes: 0,
    removedOrphans: 0,
    evictedUploads: 0,
  };

  for (const orphan of scan.orphans) {
    if (result.freedBytes >= neededBytes) break;
    if (now - orphan.mtimeMs < EVICTION_GRACE_MS) continue;
    if (await unlinkSafe(orphan.filePath)) {
      result.freedBytes += orphan.sizeBytes;
      result.removedOrphans++;
    }
  }

  if (result.freedBytes < neededBytes) {
    const idle = scan.uploads
      .filter((u) => now - u.mtimeMs >= PRESSURE_IDLE_TTL_MS)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const upload of idle) {
      if (result.freedBytes >= neededBytes) break;
      const removed = await removeUpload(upload, ledger);
      if (removed > 0) {
        // Freeing the reservation is what matters for admission, not the
        // partial bytes on disk — count the full declared size.
        result.freedBytes += Math.max(upload.sizeBytes, upload.bytesOnDisk);
        result.evictedUploads++;
        log.warn(
          { uploadId: upload.id, idleMs: now - upload.mtimeMs },
          "evicted idle in-flight upload to free staging space (its resume will fail)",
        );
      }
    }
  }

  if (result.removedOrphans > 0 || result.evictedUploads > 0) {
    log.info(result, "staging pressure eviction");
  }
  return result;
}

/** Removes a data+sidecar pair and its ledger reservation. Returns files removed. */
async function removeUpload(
  upload: ScannedUpload,
  ledger?: StagingLedger,
): Promise<number> {
  let removed = 0;
  if (await unlinkSafe(upload.dataPath)) removed++;
  if (await unlinkSafe(upload.sidecarPath)) removed++;
  if (removed > 0) ledger?.release(upload.id);
  return removed;
}

async function unlinkSafe(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false; // raced with an active upload or another GC pass
  }
}
