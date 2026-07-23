import { createLogger } from "@/lib/logger";
import type { DiscordGuildGateway } from "./guild-gateway";

const log = createLogger("guild-gate");

/**
 * Access gate (PRD §6): a user may sign in only if their Discord guild list
 * intersects ALLOWED_GUILD_IDS. Fails closed — any error in the lookup denies
 * access rather than letting unknown users in.
 */
export class GuildGate {
  constructor(
    private readonly gateway: DiscordGuildGateway,
    private readonly allowedGuildIds: readonly string[],
  ) {}

  async isAllowed(accessToken: string | null | undefined): Promise<boolean> {
    if (!accessToken) {
      log.warn("guild check skipped: no Discord access token on account");
      return false;
    }
    try {
      const memberOf = await this.gateway.listGuildIds(accessToken);
      return memberOf.some((id) => this.allowedGuildIds.includes(id));
    } catch (err) {
      log.error({ err }, "guild membership lookup failed; denying access");
      return false;
    }
  }
}
