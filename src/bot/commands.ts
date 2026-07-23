import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { createLogger } from "@/lib/logger";
import type { BotEnv } from "./env";

const log = createLogger("bot:commands");

export function commandDefinitions(opts: { embedVideo: boolean }) {
  const commands = [
    new SlashCommandBuilder()
      .setName("upload")
      .setDescription("Get the link to the file upload server")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("quota")
      .setDescription("Check your storage quota on the upload server")
      .toJSON(),
  ];
  if (opts.embedVideo) {
    commands.push(
      new SlashCommandBuilder()
        .setName("embed_video")
        .setDescription(
          "Download a video with yt-dlp and post it as a playable embed",
        )
        .addStringOption((o) =>
          o
            .setName("url")
            .setDescription("Video page URL (YouTube, Twitter/X, TikTok, …)")
            .setRequired(true),
        )
        .toJSON(),
    );
  }
  return commands;
}

/**
 * Registers slash commands in each allowed guild (guild-scoped commands
 * propagate instantly, unlike global ones). Idempotent bulk overwrite —
 * safe to run on every boot.
 */
export async function registerCommands(
  env: BotEnv,
  opts: { embedVideo: boolean },
): Promise<void> {
  const rest = new REST().setToken(env.DISCORD_BOT_TOKEN);
  const body = commandDefinitions(opts);
  for (const guildId of env.ALLOWED_GUILD_IDS) {
    await rest.put(
      Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId),
      { body },
    );
    log.info({ guildId, commands: body.length }, "slash commands registered");
  }
}
