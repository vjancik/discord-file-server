import { Client, Events, GatewayIntentBits } from "discord.js";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createLogger } from "@/lib/logger";
import { registerCommands } from "./commands";
import { createBotContainer } from "./container";
import { getBotEnv } from "./env";
import { createInteractionHandler } from "./interactions";

const POLL_INTERVAL_MS = 5_000;

const log = createLogger("bot");

/**
 * The app process owns migrations (instrumentation.ts applies them at boot);
 * running them from two processes at once could race. The bot just waits for
 * its table to appear — relevant on the very first deploy of this feature.
 */
async function waitForMigrations(db: Db): Promise<void> {
  for (;;) {
    try {
      db.run(sql`select 1 from discord_review_messages limit 1`);
      return;
    } catch {
      log.warn(
        "discord_review_messages table missing — waiting for the app to migrate",
      );
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

async function main(): Promise<void> {
  const env = getBotEnv();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const { db, review, quotaSummary, embed, ytdlp } = createBotContainer(
    env,
    client,
  );

  // The image pins a yt-dlp release that goes stale fast (site fixes ship
  // almost daily). Refresh it on every container start so a long-lived image
  // still downloads reliably; best-effort, never blocks boot on failure.
  if (embed) void ytdlp.update();

  await waitForMigrations(db);
  await registerCommands(env, { embedVideo: embed !== undefined });
  embed?.sweepScratch();

  client.on(
    Events.InteractionCreate,
    createInteractionHandler({
      review,
      quotaSummary,
      baseUrl: env.baseUrl,
      embed,
    }),
  );
  client.once(Events.ClientReady, (ready) => {
    log.info({ user: ready.user.tag }, "connected to Discord gateway");
  });
  await client.login(env.DISCORD_BOT_TOKEN);

  // Recursive timeout (not setInterval) so ticks never overlap, however slow
  // Discord or the DB gets.
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await review.tick();
    } catch (err) {
      log.error({ err }, "review tick failed");
    }
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  void tick();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    stopped = true;
    clearTimeout(timer);
    await client.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "bot failed to start");
  process.exit(1);
});
