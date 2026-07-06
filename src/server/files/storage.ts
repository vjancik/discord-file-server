import { mkdir, open, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@/lib/logger";

const log = createLogger("storage");

/**
 * Completed-file storage on the HDD array. Layout maps 1:1 to /f/* URLs
 * (PRD §7): STORAGE_DIR/<file-id>/<file-name.ext>, with an optional
 * <file-id>/thumb.jpg alongside.
 */
export class FileStorage {
  constructor(private readonly storageDir: string) {}

  dirFor(fileId: string): string {
    return path.join(this.storageDir, fileId);
  }

  pathFor(fileId: string, fileName: string): string {
    return path.join(this.storageDir, fileId, fileName);
  }

  /**
   * Move a finished upload from SSD staging into storage. Staging and storage
   * are different filesystems, so a plain rename fails with EXDEV — fall back
   * to a streamed copy + unlink (never buffers the whole file).
   */
  async moveIntoStorage(
    sourcePath: string,
    fileId: string,
    fileName: string,
  ): Promise<string> {
    const dest = this.pathFor(fileId, fileName);
    await mkdir(this.dirFor(fileId), { recursive: true });
    try {
      await rename(sourcePath, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await Bun.write(dest, Bun.file(sourcePath));
      await unlink(sourcePath);
    }
    return dest;
  }

  /** Remove a file's directory (bytes + thumbnail). Used by delete and finalize rollback. */
  async removeFileDir(fileId: string): Promise<void> {
    try {
      await rm(this.dirFor(fileId), { recursive: true, force: true });
    } catch (err) {
      // Deletion must not fail the tombstone write; log and move on.
      log.error({ err, fileId }, "failed to remove file directory");
    }
  }

  /** First bytes of a file, for magic-number sniffing (file-type needs ~4 KB). */
  async readHead(filePath: string, byteCount = 4096): Promise<Uint8Array> {
    const handle = await open(filePath, "r");
    try {
      const buf = new Uint8Array(byteCount);
      const { bytesRead } = await handle.read(buf, 0, byteCount, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}
