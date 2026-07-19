import type { FileRow } from "@/db/schema";
import { formatBytes } from "@/lib/units";
import type { FileRepository } from "../files/file.repository";

export interface QuotaConfig {
  /** STORAGE_LIMIT: total bytes for completed files across all users. */
  storageLimit: number;
  /** MAX_FILE_SIZE: optional global per-file cap. */
  maxFileSize?: number;
}

export type UploadPlan =
  | {
      action: "accept" /** oldest-first files to delete to make room (auto-delete). */;
      toDelete: FileRow[];
    }
  | { action: "reject"; reason: string };

/**
 * Quota model (PRD §7): per-user quota = STORAGE_LIMIT / active_users,
 * recomputed at upload time; active = holding ≥ 1 live file. Per-file max is
 * min(user quota, MAX_FILE_SIZE). Planning only — deletions are executed by
 * the caller so this stays pure business logic.
 */
export class QuotaService {
  constructor(
    private readonly files: FileRepository,
    private readonly config: QuotaConfig,
  ) {}

  /** Current quota for this user. A first upload makes them active, so the divisor counts them in. */
  quotaFor(userId: string): number {
    return this.quotaWith(this.files.countLiveByOwner(userId) > 0);
  }

  /**
   * Quota for someone holding no live files yet (a new or not-yet-registered
   * user): they would join the divisor, so it's STORAGE_LIMIT / (active + 1).
   */
  prospectiveQuota(): number {
    return this.quotaWith(false);
  }

  private quotaWith(isActive: boolean): number {
    const active = this.files.countActiveUsers();
    const divisor = Math.max(1, isActive ? active : active + 1);
    return Math.floor(this.config.storageLimit / divisor);
  }

  usageFor(userId: string): number {
    return this.files.sumLiveSizeByOwner(userId);
  }

  /**
   * @param pendingBytes the user's in-flight upload bytes (staging ledger
   * reservations). Counting them here closes the check-then-upload TOCTOU:
   * two concurrent uploads can no longer both pass against the same usage.
   */
  planUpload(
    userId: string,
    sizeBytes: number,
    autoDeleteOldest: boolean,
    pendingBytes = 0,
  ): UploadPlan {
    const quota = this.quotaFor(userId);
    const maxFile = Math.min(
      quota,
      this.config.maxFileSize ?? Number.POSITIVE_INFINITY,
    );

    if (sizeBytes > maxFile) {
      return {
        action: "reject",
        reason: `File is too large (${formatBytes(sizeBytes)}); the maximum is ${formatBytes(maxFile)}.`,
      };
    }

    const used = this.usageFor(userId) + pendingBytes;
    if (used + sizeBytes <= quota) return { action: "accept", toDelete: [] };

    if (!autoDeleteOldest) {
      return {
        action: "reject",
        reason: `Over quota: ${formatBytes(used)} of ${formatBytes(quota)} used, upload needs ${formatBytes(sizeBytes)}. Delete some files or enable auto-delete in settings.`,
      };
    }

    // Auto-delete: free the user's own oldest files (by upload date, regardless
    // of review status — PRD iteration 2) until the new upload fits.
    const toDelete: FileRow[] = [];
    let freed = 0;
    for (const file of this.files.listLiveByOwnerOldestFirst(userId)) {
      if (used - freed + sizeBytes <= quota) break;
      toDelete.push(file);
      freed += file.sizeBytes;
    }
    if (used - freed + sizeBytes > quota) {
      return {
        action: "reject",
        reason: `File is too large (${formatBytes(sizeBytes)}) to fit your quota of ${formatBytes(quota)}, even after auto-deleting old files.`,
      };
    }
    return { action: "accept", toDelete };
  }
}
