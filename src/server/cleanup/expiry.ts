import { createLogger } from "@/lib/logger";
import type { FileRepository } from "../files/file.repository";
import type { FileService } from "../files/file.service";

const log = createLogger("expiry");

/**
 * Deletes live files past their expiresAt (DEFAULT_FILE_EXPIRY; unset = files
 * never expire and this is a no-op). System deletions tombstone with a null actor.
 */
export async function deleteExpiredFiles(
  repo: FileRepository,
  files: FileService,
  now = new Date(),
): Promise<number> {
  const expired = repo.listExpired(now);
  for (const file of expired) {
    await files.delete(file.id, null);
  }
  if (expired.length > 0)
    log.info({ count: expired.length }, "expired files deleted");
  return expired.length;
}
