import { defineConfig } from "@playwright/test";

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

// E2E stack: dev server on its own port with a throwaway database and the
// E2E_TEST_AUTH credential path enabled (see src/auth/auth.ts).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // specs share one server + database
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `rm -rf .data/e2e && mkdir -p .data/e2e/staging .data/e2e/uploads && bun --bun next dev -p ${PORT}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      E2E_TEST_AUTH: "1",
      DOMAIN: "localhost",
      BASE_URL,
      STORAGE_LIMIT: "1GB",
      STAGING_LIMIT: "1GB",
      ALLOWED_GUILD_IDS: "e2e-guild",
      ADMIN_DISCORD_IDS: "e2e-admin-discord-id",
      DISCORD_CLIENT_ID: "e2e-dummy",
      DISCORD_CLIENT_SECRET: "e2e-dummy",
      BETTER_AUTH_SECRET: "e2e-secret-0123456789abcdef0123456789abcdef",
      STAGING_DIR: "./.data/e2e/staging",
      STORAGE_DIR: "./.data/e2e/uploads",
      DATABASE_PATH: "./.data/e2e/db.sqlite",
    },
  },
});
