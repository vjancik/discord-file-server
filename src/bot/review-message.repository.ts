import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { discordReviewMessages } from "@/db/schema";

export interface ReviewMessageRef {
  fileId: string;
  channelId: string;
  messageId: string;
}

/**
 * Open review announcements the bot has posted to the admin channel. A row
 * exists only while a decision is outstanding; resolving (approve/reject, or
 * the file leaving the pending state via the web UI) deletes it.
 */
export class ReviewMessageRepository {
  constructor(private readonly db: Db) {}

  insert(ref: ReviewMessageRef): void {
    this.db.insert(discordReviewMessages).values(ref).run();
  }

  listOpen(): ReviewMessageRef[] {
    return this.db
      .select({
        fileId: discordReviewMessages.fileId,
        channelId: discordReviewMessages.channelId,
        messageId: discordReviewMessages.messageId,
      })
      .from(discordReviewMessages)
      .all();
  }

  findByFileId(fileId: string): ReviewMessageRef | undefined {
    return this.db
      .select({
        fileId: discordReviewMessages.fileId,
        channelId: discordReviewMessages.channelId,
        messageId: discordReviewMessages.messageId,
      })
      .from(discordReviewMessages)
      .where(eq(discordReviewMessages.fileId, fileId))
      .get();
  }

  delete(fileId: string): void {
    this.db
      .delete(discordReviewMessages)
      .where(eq(discordReviewMessages.fileId, fileId))
      .run();
  }
}
