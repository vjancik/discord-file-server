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
 */
export class StatfsDiskProbe implements DiskProbe {
  async freeBytes(dir: string): Promise<number> {
    const stats = await statfs(dir);
    return stats.bavail * stats.bsize;
  }
}
