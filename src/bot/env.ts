import { z } from "zod";
import { bytes, csv, deriveBaseUrl } from "@/lib/env";

/**
 * The bot's own env surface — deliberately smaller than the server's
 * (no auth secrets, no quota/staging config). Both processes read the same
 * .env file; this schema just validates the subset the bot actually uses.
 */
const botEnvSchema = z.object({
  /** Bot token from the Discord developer portal (Bot → Token). */
  DISCORD_BOT_TOKEN: z.string().min(1),
  /** Application ID — same OAuth app the server uses; needed to register slash commands. */
  DISCORD_CLIENT_ID: z.string().min(1),
  /** Channel where pending uploads are announced with Approve/Reject buttons. */
  ADMIN_CHANNEL_ID: z.string().min(1),
  /** Discord user IDs allowed to press Approve/Reject (same list the server uses). */
  ADMIN_DISCORD_IDS: csv,
  /** Guilds to register slash commands in (same allow-list the server uses). */
  ALLOWED_GUILD_IDS: csv,
  DOMAIN: z.string().min(1),
  BASE_URL: z.url().optional(),
  /** Same values the server uses — /quota computes with the server's quota math. */
  STORAGE_LIMIT: bytes,
  MAX_FILE_SIZE: bytes.optional(),
  DATABASE_PATH: z.string().min(1),
  /** Needed because reject-delete removes the file's bytes directly. */
  STORAGE_DIR: z.string().min(1),
  /**
   * Secret(s) shared with the server for upload service tokens
   * (docs/embed-auth.md). Unset = /embed_video is not registered.
   */
  BOT_SERVICE_SECRET: csv.optional(),
  /** Discord's inline-embed size threshold (docs/embed-video.md). */
  EMBED_SIZE_LIMIT: bytes.prefault("80MB"),
  /** SSD workspace for yt-dlp downloads; per-job subdirs, swept at boot. */
  EMBED_SCRATCH_DIR: z.string().min(1).default("./.data/embed-scratch"),
  /** Max bytes the scratch workspace may hold. */
  EMBED_SCRATCH_LIMIT: bytes.prefault("10GB"),
  /**
   * Where the bot uploads to. Defaults to `${baseUrl}/api/upload`; in Docker
   * set it to the app container directly (http://app:3000/api/upload) so
   * uploads stay on the internal network instead of the public edge.
   */
  UPLOAD_ENDPOINT: z.url().optional(),
});

export type BotEnv = z.infer<typeof botEnvSchema> & { baseUrl: string };

let cached: BotEnv | undefined;

export function getBotEnv(): BotEnv {
  if (cached) return cached;
  const parsed = botEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Bot environment validation failed:\n${z.prettifyError(parsed.error)}`,
    );
  }
  cached = {
    ...parsed.data,
    baseUrl: deriveBaseUrl(parsed.data.DOMAIN, parsed.data.BASE_URL),
  };
  return cached;
}

/** Test-only: reset the memoized env so tests can vary process.env. */
export function resetBotEnvCache(): void {
  cached = undefined;
}
