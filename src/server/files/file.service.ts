import { createLogger } from "@/lib/logger";
import type { FileRepository } from "./file.repository";
import type { FileStorage } from "./storage";

const log = createLogger("files");

/**
 * File lifecycle actions shared by the dashboard, the admin views, quota
 * auto-delete, and the expiry job. Deletion = bytes gone + tombstone row;
 * every link dies instantly (PRD §3).
 */
export class FileService {
  constructor(
    private readonly repo: FileRepository,
    private readonly storage: FileStorage,
  ) {}

  /**
   * Delete a live file. `actorId` is recorded on the tombstone (null = system,
   * e.g. expiry); callers are responsible for authorization (owner or admin).
   */
  async delete(fileId: string, actorId: string | null): Promise<void> {
    const file = this.repo.findLiveById(fileId);
    if (!file) return; // already gone — deletion is idempotent
    this.repo.markDeleted(fileId, actorId);
    await this.storage.removeFileDir(fileId);
    log.info({ fileId, actorId }, "file deleted");
  }

  approve(fileId: string): void {
    this.repo.approve(fileId);
    log.info({ fileId }, "file approved");
  }
}
