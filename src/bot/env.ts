import { z } from "zod";
import { csv, deriveBaseUrl } from "@/lib/env";

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
  DATABASE_PATH: z.string().min(1),
  /** Needed because reject-delete removes the file's bytes directly. */
  STORAGE_DIR: z.string().min(1),
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
