import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { nextCookies } from "better-auth/next-js";
import { getDb, schema } from "@/db/client";
import { getEnv } from "@/lib/env";
import { parseBool } from "@/lib/units";
import { GuildGate } from "@/server/discord/guild-gate";
import { HttpDiscordGuildGateway } from "@/server/discord/guild-gateway";
import { getDiscordAccount } from "./discord-account";

// E2E-only credential path (never set in production): lets Playwright sign in
// with email/password and skips the Discord guild gate, instead of hand-rolling
// an auth bypass in app code. Gated on an env var read once at boot.
const isE2ETestAuth = process.env.E2E_TEST_AUTH === "1";

// Reads env directly with build-safe fallbacks: this module is evaluated during
// `next build` route enumeration where runtime env is absent. Real config is
// enforced at boot by instrumentation.ts via getEnv().
export const auth = betterAuth({
  baseURL:
    process.env.BASE_URL ??
    (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : undefined),
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(getDb(), {
    provider: "sqlite",
    schema,
  }),
  socialProviders: {
    discord: {
      clientId: process.env.DISCORD_CLIENT_ID ?? "",
      clientSecret: process.env.DISCORD_CLIENT_SECRET ?? "",
      // Explicit scopes only — Better Auth would otherwise add its default
      // `identify email`. Email stays off the consent screen unless the
      // deployment opts in via REQUIRE_EMAIL.
      disableDefaultScope: true,
      scope: parseBool(process.env.REQUIRE_EMAIL)
        ? ["identify", "guilds", "email"]
        : ["identify", "guilds"],
      // Discord can return email: null even when the scope is granted
      // (phone-only accounts), and Better Auth requires a user email —
      // synthesize a stable placeholder from the immutable Discord ID.
      mapProfileToUser: (profile) => ({
        email: profile.email ?? `${profile.id}@discord.placeholder.local`,
      }),
    },
  },
  emailAndPassword: { enabled: isE2ETestAuth },
  databaseHooks: {
    session: {
      create: {
        // Runs on every sign-in: the guild gate (PRD §6) re-checks Discord
        // guild membership each time a session is created, and blocks the
        // sign-in entirely when the user is in none of the allowed guilds.
        before: async (session) => {
          if (isE2ETestAuth) return;
          const discordAccount = getDiscordAccount(getDb(), session.userId);
          const gate = new GuildGate(
            new HttpDiscordGuildGateway(),
            getEnv().ALLOWED_GUILD_IDS,
          );
          if (!(await gate.isAllowed(discordAccount?.accessToken))) {
            throw new APIError("FORBIDDEN", {
              message:
                "You must be a member of an allowed Discord server to use this service.",
            });
          }
        },
      },
    },
  },
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
