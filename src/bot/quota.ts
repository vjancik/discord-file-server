import { formatBytes } from "@/lib/units";
import type { FileRepository } from "@/server/files/file.repository";
import type { QuotaService } from "@/server/quota/quota.service";
import type { Identity } from "./review.service";

/**
 * Text for the /quota reply. Reuses the server's QuotaService so the numbers
 * always match the web UI: per-user quota = STORAGE_LIMIT / active_users,
 * where users holding no live files (including people who never signed in)
 * would join the divisor — their prospective quota is STORAGE_LIMIT /
 * (active + 1), never a double-counted share.
 */
export class QuotaSummaryService {
  constructor(
    private readonly quota: QuotaService,
    private readonly fileRepo: FileRepository,
    private readonly identity: Identity,
    private readonly baseUrl: string,
  ) {}

  summaryFor(discordId: string): string {
    const userId = this.identity.userIdForDiscord(discordId);
    if (userId === null) {
      return (
        `You don't have an upload-server account yet — sign in at <${this.baseUrl}> to get one.\n` +
        `Your quota would currently be **${formatBytes(this.quota.prospectiveQuota())}**.`
      );
    }

    const quota = this.quota.quotaFor(userId);
    const used = this.quota.usageFor(userId);
    const free = Math.max(0, quota - used);
    const fileCount = this.fileRepo.countLiveByOwner(userId);
    const files = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
    // Usage can exceed the quota without any misbehavior: the per-user share
    // shrinks whenever another user becomes active.
    const overQuota =
      used > quota
        ? `\n⚠️ You're **${formatBytes(used - quota)}** over the current limit (it shrinks as more users become active) — please delete some older files before uploading new ones.`
        : "";
    return (
      `You're using **${formatBytes(used)}** of your **${formatBytes(quota)}** quota (${files}) — **${formatBytes(free)}** free.${overQuota}\n` +
      `Quota shifts as users join or leave; manage your files at <${this.baseUrl}/files>`
    );
  }
}
