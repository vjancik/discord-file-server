---
name: verify
description: Build/launch/drive recipe for verifying changes to this upload server at its real surfaces (web UI, tus API).
---

# Verifying upload-server changes

## Launch (dev server with throwaway e2e env)

Same env as `playwright.config.ts` webServer; run in background:

```bash
rm -rf .data/e2e && mkdir -p .data/e2e/staging .data/e2e/uploads && \
E2E_TEST_AUTH=1 DOMAIN=localhost BASE_URL=http://localhost:3100 \
STORAGE_LIMIT=1GB STAGING_LIMIT=1GB ALLOWED_GUILD_IDS=e2e-guild \
ADMIN_DISCORD_IDS=e2e-admin-discord-id DISCORD_CLIENT_ID=e2e-dummy \
DISCORD_CLIENT_SECRET=e2e-dummy \
BETTER_AUTH_SECRET=e2e-secret-0123456789abcdef0123456789abcdef \
STAGING_DIR=./.data/e2e/staging STORAGE_DIR=./.data/e2e/uploads \
DATABASE_PATH=./.data/e2e/db.sqlite \
bunx cross-env AGENT=1 bun --bun next dev -p 3100
```

Ready when `curl -sf http://localhost:3100/login` succeeds (~20 s).

## Auth

`E2E_TEST_AUTH=1` enables email sign-up: POST `/api/auth/sign-up/email` with
`{email, password, name}` → `set-cookie: better-auth.session_token=...`.

Gotcha: standalone Playwright scripts run under **bun** crash in
`page.request` set-cookie parsing. Sign up with plain `fetch()` instead and
inject the cookie via `context.addCookies` (domain `localhost`, path `/`).

## Driving the Uppy upload UI (Playwright, headless chromium)

- File input: `.uppy-Dashboard input[type="file"]` + `setInputFiles` with an
  in-memory buffer. `e2e/helpers.ts` has `fakeMp4Bytes()` (valid ftyp header).
- Start: `getByRole("button", { name: /^upload \d+ file/i })`.
- Status bar details text: `.uppy-StatusBar-statusSecondary` (hidden while
  paused). Pause/resume toggle: `[data-cy="togglePauseResume"]` (the
  role-based /pause/i locator is ambiguous — matches the per-file button too).
- After "Upload complete" the file input is detached; click the `Done` button
  to reset the dashboard before adding more files.
- To make progress observable, throttle via CDP:
  `Network.emulateNetworkConditions` with `uploadThroughput: 2 * 1024 * 1024`
  and upload a ~20 MB file.

## Flows worth driving

- Upload → share link `code:has-text("/s/")` appears → link resolves.
- `/files` dashboard for delete; Discordbot UA gets OG page (see
  `e2e/upload-flow.spec.ts` for both).
