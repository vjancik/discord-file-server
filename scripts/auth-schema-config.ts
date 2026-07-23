import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";

// CLI-only config for `bunx @better-auth/cli generate`. The real runtime config
// (src/auth/auth.ts) imports bun:sqlite, which the CLI's node-based loader can't
// resolve. Keep table-affecting options (plugins, adapters) in sync with it.
export const auth = betterAuth({
  // biome-ignore lint/suspicious/noExplicitAny: schema generation never queries the db
  database: drizzleAdapter({} as any, { provider: "sqlite" }),
  socialProviders: {
    discord: { clientId: "cli", clientSecret: "cli" },
  },
});
