import type { Client } from "discord.js";
import { createDb } from "@/db/client";
import { FileRepository } from "@/server/files/file.repository";
import { FileService } from "@/server/files/file.service";
import { FileStorage } from "@/server/files/storage";
import { QuotaService } from "@/server/quota/quota.service";
import { mintServiceToken } from "@/server/uploads/service-token";
import { EmbedService } from "./embed/embed.service";
import { tusUpload } from "./embed/tus-client";
import { EmbedVerifier } from "./embed/verify";
import { YtDlp } from "./embed/ytdlp";
import type { BotEnv } from "./env";
import { DbIdentity } from "./identity";
import { DiscordReviewMessenger } from "./messenger";
import { QuotaSummaryService } from "./quota";
import { ReviewService } from "./review.service";
import { ReviewMessageRepository } from "./review-message.repository";

/** Upload tokens outlive one yt-dlp+upload attempt comfortably. */
const TOKEN_TTL_MS = 15 * 60_000;

/**
 * Composition root for the bot process. Reuses the server's repositories and
 * FileService over the same SQLite file and storage mount, so approve/reject
 * behave exactly like the web admin UI; tests construct services with fakes.
 */
export function createBotContainer(env: BotEnv, client: Client) {
  const db = createDb(env.DATABASE_PATH);
  const fileRepo = new FileRepository(db);
  const identity = new DbIdentity(db);
  const quota = new QuotaService(fileRepo, {
    storageLimit: env.STORAGE_LIMIT,
    maxFileSize: env.MAX_FILE_SIZE,
  });
  const review = new ReviewService(
    fileRepo,
    new FileService(fileRepo, new FileStorage(env.STORAGE_DIR)),
    new ReviewMessageRepository(db),
    new DiscordReviewMessenger(client, env.ADMIN_CHANNEL_ID),
    identity,
    { baseUrl: env.baseUrl, adminDiscordIds: env.ADMIN_DISCORD_IDS },
  );
  const quotaSummary = new QuotaSummaryService(
    quota,
    fileRepo,
    identity,
    env.baseUrl,
  );
  const embed = createEmbedService(env, identity, quota);
  return { db, review, quotaSummary, embed };
}

/** /embed_video needs the shared service secret; without it, no command. */
function createEmbedService(
  env: BotEnv,
  identity: DbIdentity,
  quota: QuotaService,
): EmbedService | undefined {
  const secrets = env.BOT_SERVICE_SECRET;
  if (!secrets) return undefined;
  const endpoint = env.UPLOAD_ENDPOINT ?? `${env.baseUrl}/api/upload`;
  return new EmbedService(
    {
      ytdlp: new YtDlp(),
      verifier: new EmbedVerifier(),
      upload: (opts) => tusUpload({ ...opts, endpoint }),
      identity,
      quota,
      mintToken: (userId, maxBytes) =>
        mintServiceToken(secrets[0], {
          userId,
          exp: Date.now() + TOKEN_TTL_MS,
          jti: crypto.randomUUID(),
          maxBytes,
        }),
    },
    {
      embedLimit: env.EMBED_SIZE_LIMIT,
      maxFileSize: env.MAX_FILE_SIZE,
      scratchDir: env.EMBED_SCRATCH_DIR,
      scratchLimit: env.EMBED_SCRATCH_LIMIT,
    },
  );
}
