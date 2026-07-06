import { createLogger } from "@/lib/logger";

/**
 * Port for the Discord "which guilds is this user in" lookup, so the guild
 * gate is testable with a fake and never needs the real API in tests.
 */
export interface DiscordGuildGateway {
  /** IDs of guilds the user belongs to, given their OAuth access token. */
  listGuildIds(accessToken: string): Promise<string[]>;
}

const log = createLogger("discord-guild-gateway");

/** Real adapter: GET /users/@me/guilds with the user's OAuth token (scope: guilds). */
export class HttpDiscordGuildGateway implements DiscordGuildGateway {
  async listGuildIds(accessToken: string): Promise<string[]> {
    const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "Discord guild list request failed");
      throw new Error(`Discord API responded ${res.status}`);
    }
    const guilds = (await res.json()) as Array<{ id: string }>;
    return guilds.map((g) => g.id);
  }
}
