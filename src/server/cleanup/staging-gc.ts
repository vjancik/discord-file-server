import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@/lib/logger";

const log = createLogger("staging-gc");

/** Default TTL for abandoned partial uploads: 24 h (PRD open item — sensible default). */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes stale in-progress tus uploads (data files + .json info sidecars)
 * whose mtime is older than the TTL. A parked resumable upload writes on every
 * chunk, so anything untouched for a day is abandoned.
 */
export async function collectStagingGarbage(
  stagingDir: string,
  ttlMs: number = STAGING_TTL_MS,
  now: number = Date.now(),
): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(stagingDir);
  } catch (err) {
    log.warn({ err, stagingDir }, "staging dir not readable");
    return 0;
  }
  for (const entry of entries) {
    const filePath = path.join(stagingDir, entry);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || now - info.mtimeMs < ttlMs) continue;
      await unlink(filePath);
      removed++;
    } catch {
      // raced with an active upload or another GC pass — skip
    }
  }
  if (removed > 0) log.info({ removed }, "removed stale staging uploads");
  return removed;
}
