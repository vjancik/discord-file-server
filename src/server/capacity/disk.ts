import { statfs } from "node:fs/promises";

/**
 * Bytes to keep free on a volume beyond what admission math requires:
 * absorbs sidecar .json files, thumbnails, SQLite WAL growth and general
 * filesystem overhead that the byte-level accounting doesn't model.
 */
export const DISK_HEADROOM_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** Free bytes below which the hourly monitor logs a low-disk warning. */
export const LOW_DISK_WARN_BYTES = 2 * DISK_HEADROOM_BYTES;

/** Reports free bytes on the volume backing a directory. */
export interface DiskProbe {
  freeBytes(dir: string): Promise<number>;
}

/**
 * statfs-based probe. Bun implements `node:fs` statfs natively (verified on
 * Bun 1.3), so no subprocess (`df`) fallback is needed. Uses `bavail`
 * (blocks available to unprivileged processes) rather than `bfree` so the
 * root-reserved blocks the app can't actually write to aren't counted.
 *
 * Computed in `bigint` mode: on large or union filesystems (e.g. mergerfs)
 * `bavail * bsize` can exceed `Number.MAX_SAFE_INTEGER`, and doing the
 * multiply in JS `number` there overflows/loses precision — mergerfs was
 * observed returning a *negative* free-space figure, which then propagated
 * through the admission math and rejected every upload with a bogus
 * "out of disk space". bigint keeps the product exact; we only narrow to
 * `number` after clamping to a non-negative value that fits safely.
 */
export class StatfsDiskProbe implements DiskProbe {
  async freeBytes(dir: string): Promise<number> {
    const stats = await statfs(dir, { bigint: true });
    return usableFreeBytes(stats.bavail, stats.bsize);
  }
}

const ZERO = BigInt(0);
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Blocks-available × block-size, clamped to a safe non-negative `number`.
 * Kept as a pure bigint helper so the mergerfs overflow case is unit-testable
 * without mocking `statfs`. A union FS can report inconsistent counts, so a
 * non-positive or oversized product is floored to 0 / MAX_SAFE_INTEGER rather
 * than poisoning the admission arithmetic downstream.
 */
export function usableFreeBytes(bavail: bigint, bsize: bigint): number {
  const free = bavail * bsize;
  if (free <= ZERO) return 0;
  return Number(free > MAX_SAFE_BIG ? MAX_SAFE_BIG : free);
}
