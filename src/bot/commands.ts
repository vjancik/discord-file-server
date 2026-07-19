import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { createLogger } from "@/lib/logger";
import type { BotEnv } from "./env";

const log = createLogger("bot:commands");

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("upload")
    .setDescription("Get the link to the file upload server")
    .toJSON(),
];

/**
 * Registers slash commands in each allowed guild (guild-scoped commands
 * propagate instantly, unlike global ones). Idempotent bulk overwrite —
 * safe to run on every boot.
 */
export async function registerCommands(env: BotEnv): Promise<void> {
  const rest = new REST().setToken(env.DISCORD_BOT_TOKEN);
  for (const guildId of env.ALLOWED_GUILD_IDS) {
    await rest.put(
      Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId),
      { body: commandDefinitions },
    );
    log.info({ guildId }, "slash commands registered");
  }
}
