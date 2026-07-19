import type { Client } from "discord.js";
import { createDb } from "@/db/client";
import { FileRepository } from "@/server/files/file.repository";
import { FileService } from "@/server/files/file.service";
import { FileStorage } from "@/server/files/storage";
import { QuotaService } from "@/server/quota/quota.service";
import type { BotEnv } from "./env";
import { DbIdentity } from "./identity";
import { DiscordReviewMessenger } from "./messenger";
import { QuotaSummaryService } from "./quota";
import { ReviewService } from "./review.service";
import { ReviewMessageRepository } from "./review-message.repository";

/**
 * Composition root for the bot process. Reuses the server's repositories and
 * FileService over the same SQLite file and storage mount, so approve/reject
 * behave exactly like the web admin UI; tests construct services with fakes.
 */
export function createBotContainer(env: BotEnv, client: Client) {
  const db = createDb(env.DATABASE_PATH);
  const fileRepo = new FileRepository(db);
  const identity = new DbIdentity(db);
  const review = new ReviewService(
    fileRepo,
    new FileService(fileRepo, new FileStorage(env.STORAGE_DIR)),
    new ReviewMessageRepository(db),
    new DiscordReviewMessenger(client, env.ADMIN_CHANNEL_ID),
    identity,
    { baseUrl: env.baseUrl, adminDiscordIds: env.ADMIN_DISCORD_IDS },
  );
  const quotaSummary = new QuotaSummaryService(
    new QuotaService(fileRepo, {
      storageLimit: env.STORAGE_LIMIT,
      maxFileSize: env.MAX_FILE_SIZE,
    }),
    fileRepo,
    identity,
    env.baseUrl,
  );
  return { db, review, quotaSummary };
}
