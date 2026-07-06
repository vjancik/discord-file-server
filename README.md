# DiscordFileServer

A self-hosted file sharing service built to get around Discord's upload limits. Members of an allowed Discord server sign in with Discord, upload large files through a resumable-upload UI, and get short links that unfurl properly when pasted back into Discord — inline video player with scrubbing, image previews, audio player — while the actual bytes are served straight off a homelab disk array, never touching the application runtime.

The interesting problems here aren't CRUD: making arbitrary self-hosted URLs *embed correctly in Discord* (UA-sniffed Open Graph pages, the fxtwitter/InstaFix technique), keeping a JS runtime out of the download path entirely, resumable multi-gigabyte uploads onto spinning rust without fragmenting it, and a capability-URL security model chosen deliberately over per-download auth.

## Contents

- [Features](#features)
- [Architecture](#architecture)
  - [Control plane vs. data plane](#control-plane-vs-data-plane)
  - [Upload pipeline](#upload-pipeline)
  - [Discord embed strategy](#discord-embed-strategy)
  - [Security model](#security-model)
  - [Quota model](#quota-model)
  - [Code layout](#code-layout)
- [Stack](#stack)
- [Development](#development)
- [Testing](#testing)
- [Deployment](#deployment)
  - [Configuration reference](#configuration-reference)
- [Design notes & trade-offs](#design-notes--trade-offs)

## Features

- **Discord OAuth sign-in, guild-gated** — access requires membership in one of the configured Discord servers, re-verified against the Discord API on every session creation. Admins are pinned by Discord user ID.
- **Resumable uploads** — tus protocol end to end ([`@tus/server`](https://github.com/tus/tus-node-server) mounted in a Next.js route handler, Uppy Dashboard in the browser): drag-drop, multi-file, pause/resume, retry, fail-fast validation before the first byte is accepted.
- **Links that embed in Discord** — every upload gets a canonical URL (`/f/<id>/<name.ext>`) and an auto-generated short link (`/s/<code>`). Both unfurl as native players/cards in Discord; non-media files unfurl as a card whose link direct-downloads.
- **User dashboard** — sortable table of your uploads with thumbnails, inline preview (video/image/audio), copy-link, and delete with a "don't ask again" opt-out. Deleting a file kills every shared link instantly.
- **Post-moderation review queue** — uploads are live immediately with status `pending`; admins get a preview-first review queue (click row → player) with single/bulk approve and delete, plus a global file browser with filters that keeps deleted files visible as audit tombstones.
- **Dynamic storage quotas** — a global storage budget divided among active users, recomputed at upload time, with an opt-in "auto-delete my oldest files to make room" mode.
- **File-type policy** — anything non-executable is accepted. Executables are rejected twice: by extension at upload creation, and by magic-byte sniffing of the actual bytes before publishing (client-reported MIME is never trusted).
- **Ops hygiene** — Litestream streams the SQLite database to a replica continuously; abandoned partial uploads are garbage-collected; optional server-wide file expiry.

## Architecture

### Control plane vs. data plane

The core decision: **the application handles logic, Caddy handles bytes.** No JavaScript runtime ever sits in the download path.

```
                        ┌─────────────────────────────────────────┐
 Discord clients ──────▶│ Caddy (TLS via Let's Encrypt, {$DOMAIN})│
 Browsers        ──────▶│                                         │
                        │  /f/*  ──▶ file_server (HDD array)      │   data plane
                        │  everything else ──▶ reverse_proxy      │
                        └───────────────┬─────────────────────────┘
                                        ▼
                        ┌─────────────────────────────────────────┐
                        │ Next.js standalone (Bun, :3000)         │   control plane
                        │  auth · upload UI · dashboards · admin  │
                        │  /s/* short links & OG pages ·          │
                        │  tus endpoint · cleanup jobs            │
                        └───────────────┬─────────────────────────┘
                                        ▼
                          SQLite (metadata) · SSD staging ──mv──▶ HDD array
```

Caddy's `file_server` gives Range requests, ETags, and conditional GETs for free — Range support is what makes Discord's video scrubbing work. The storage layout maps 1:1 to URLs (`STORAGE_DIR/<file-id>/<name.ext>` ⇔ `/f/<file-id>/<name.ext>`), so serving a file is a pure filesystem lookup with no application involvement. A Next.js fallback route for `/f/*` exists only so local dev and e2e tests work without Caddy; in production Caddy matches the path first and the handler is unreachable.

### Upload pipeline

1. Uppy sends tus chunks to `/api/upload` (a catch-all route handler wrapping `@tus/server`'s Web-API mode).
2. **Before the upload is created** — with the size known up front from tus metadata — three gates run in order: session auth, file-type policy, and quota. Oversized or disallowed uploads fail immediately instead of at 100%.
3. Chunks append to an **SSD staging directory** (chunked appends are unkind to an HDD array).
4. On completion, the finalize service: sniffs the leading bytes for executable signatures (PE/ELF/Mach-O/shebang), probes dimensions and duration with ffprobe, renders a thumbnail with ffmpeg, then **moves the file to the array as one sequential write** — `rename()` when possible, streamed copy+unlink across filesystems (`EXDEV`).
5. A DB row is inserted (status `pending`, live immediately), a short code is generated, and the tus response body hands both URLs back to the browser for the copy button.

Everything after a failure rolls back: bytes already placed in storage are removed, and a periodic GC deletes staging files whose mtime exceeds a TTL (a parked resumable upload touches its file on every chunk, so stale means abandoned).

### Discord embed strategy

Discord's crawler (`Discordbot` UA) follows redirects and embeds based on the final response's `Content-Type` — so a 302 from a short link to a raw `.mp4` already produces an inline player. This project layers the richer [fxtwitter/InstaFix](https://github.com/FixTweet/FxTwitter) technique on top. `/s/<code>` sniffs the User-Agent:

- **Embed crawlers** get a minimal HTML page with Open Graph tags: `og:video` (+ `og:video:type`, `og:video:width/height` from ffprobe — Discord sizes the player from these) pointing at the raw file, `og:image` for the poster thumbnail. Images and audio get the analogous `og:image` / `og:audio` treatment.
- **Everyone else** gets a 302 to the canonical URL.

Non-media files can't render as players, so they unfurl as a card: `og:title` is the original filename (extension included), `og:description` is "size — uploaded by name", and the link itself serves with `Content-Disposition: attachment` so clicking it downloads directly. Media is **never** served with an attachment disposition — that's the single most common way to kill a Discord embed, and it's enforced in the Caddyfile by extension matcher.

Two constraints are accepted rather than fought: Discord caches unfurls per-URL server-side (iterate on OG tags with fresh short codes), and YouTube-style iframe players are limited to Discord's hardcoded domain allowlist (raw `og:video` → mp4 gives an inline player anyway).

### Security model

**Capability URLs, not per-download auth** — the same model as Discord's own CDN. The file ID is 128 bits of CSPRNG output in base64url; possession of the URL *is* the authorization. This is a deliberate choice, not an omission:

- A redirect necessarily hands the client the final URL, so "only accessible via the short link" is not an enforceable property.
- Referer/Origin checks would break the actual product (Discord hotlinking the file **is** the point) and are trivially spoofable anyway.
- Signed expiring URLs (S3-style) would break old Discord embeds, which re-fetch from origin indefinitely.

What holds instead: **revocation** — deleting a file removes the bytes, so every link dies at once (the DB row survives as a tombstone recording who deleted what, when); `X-Robots-Tag: noindex` plus `robots.txt` keep leaked links out of search engines (the realistic exposure vector); directory listing is off; and everything except the file bytes themselves sits behind an authenticated, guild-gated session. Upload-side defenses assume a hostile client: filenames are sanitized before touching disk or URLs, media MIME types are derived from extensions rather than the client's claim, and file contents are sniffed before publishing.

### Quota model

Per-user quota is `STORAGE_LIMIT / active_users`, recomputed at upload time, where *active* means "currently holds at least one live file" (a first upload counts its owner into the divisor). If the divisor grows and someone lands over their new quota, nothing is force-deleted — they just can't upload until they free space, or they opt into auto-delete, which removes their own oldest files (by upload date, ignoring review status) until the new upload fits. An optional `MAX_FILE_SIZE` caps single files below the quota.

### Code layout

Hexagonal-lite: business logic lives in plain services with injected dependencies, so the interesting rules are testable without HTTP, Discord, or ffmpeg.

```
src/
  server/            services + ports
    files/           type policy · finalize pipeline · repository · storage (EXDEV-safe moves)
    quota/           quota math + upload planning (pure; deletions executed by the caller)
    embeds/          OG tag builder · UA sniffing (pure functions)
    discord/         guild gate + DiscordGuildGateway port (HTTP adapter / fake for tests)
    media/           MediaProber port (ffprobe/ffmpeg adapter / fake for tests)
    cleanup/         staging GC · expiry job
    container.ts     composition root — the only place real adapters are wired
  auth/              Better Auth config (Discord OAuth, guild-gate session hook) · DAL
  db/                Drizzle schema · generated auth schema · migrations · bun:sqlite client
  app/               routes: upload page, dashboard, settings, admin, /s/*, /f/* fallback, tus endpoint
  lib/               env (zod-validated) · logger (pino) · shared helpers
```

The guild gate runs inside Better Auth's `session.create.before` database hook — the same enforcement point the library's own ban feature uses — and fails closed if the Discord API errors. `instrumentation.ts` validates env and applies migrations before the server accepts requests.

## Stack

| Concern | Choice |
|---|---|
| Framework / runtime | Next.js 16 (App Router, standalone output) on **Bun** — dev, build, tests, and the production server |
| Auth | Better Auth — Discord OAuth (`identify` + `guilds` scopes), Drizzle adapter |
| Database | SQLite via `bun:sqlite` + Drizzle ORM; Litestream replication |
| Uploads | tus (`@tus/server` + `@tus/file-store`), Uppy Dashboard |
| Media | ffprobe/ffmpeg (metadata + thumbnails), magic-byte sniffing via `file-type` |
| Edge | Caddy — automatic HTTPS, static file serving, reverse proxy |
| UI | Tailwind v4 + shadcn/ui, TanStack Table, dark-first theme |
| Quality | Biome, `bun test` (+ Testing Library/happy-dom), Playwright |

Notably absent, on purpose: object storage (local disks are the point), a separate upload/link-resolver microservice (link resolution is one indexed lookup; the heavy lifting is Caddy's job), and TanStack Query (Server Components + Server Actions cover the UI's needs).

## Development

```bash
bun install
cp .env.example .env        # fill in at least the Discord OAuth credentials
bun run dev                 # http://localhost:3000
```

Discord OAuth setup: create an application at the [Discord developer portal](https://discord.com/developers/applications), add `http://localhost:3000/api/auth/callback/discord` as a redirect URL, and put the client ID/secret plus your guild and admin IDs in `.env`. Migrations run automatically at boot; `bun run db:generate` regenerates them after schema changes.

Useful scripts: `typecheck`, `codecheck` / `codecheck:fix` (Biome), `test`, `test:e2e`, `prod:up` / `prod:down`.

## Testing

- **Unit + integration** — `bun run test` (~80 tests): quota math and divisor edge cases, type policy and executable sniffing, OG tag generation, UA detection, tombstone semantics, repositories against real temp SQLite files, and the finalize pipeline against temp directories with a fake prober.
- **Component** — same runner, via happy-dom + Testing Library: the delete-confirmation dialog (including the "don't ask again" persistence), dashboard table states.
- **End-to-end** — `bun run test:e2e` (Playwright): boots a dedicated server with a throwaway database and drives the real flows — sign-in, tus upload through Uppy, short-link resolution as both a browser (302) and Discordbot (OG page), deletion killing both URLs, admin review/approve, admin-route 404s for non-admins. E2e auth uses an env-gated (`E2E_TEST_AUTH=1`) email/password path so no test bypass exists in application logic.
- **Manual** — [docs/manual-embed-checklist.md](docs/manual-embed-checklist.md) covers what only Discord itself can verify: actual embed rendering per media type, the >500 MB video case, and mobile clipboard behavior.

## Deployment

Docker Compose runs three containers: the app (standalone Next.js build executed by Bun, with ffmpeg in the image), Caddy, and Litestream.

```bash
cp .env.example .env
# set: DOMAIN, STORAGE_LIMIT, ALLOWED_GUILD_IDS, ADMIN_DISCORD_IDS,
#      DISCORD_CLIENT_ID/SECRET, BETTER_AUTH_SECRET (openssl rand -base64 32),
#      HOST_* paths (see below)
bun run prod:up
```

Requirements:

- DNS for `DOMAIN` pointing at the box, with ports 80/443 reachable — Caddy provisions and renews Let's Encrypt certificates automatically. (If 80/443 can't be exposed, switch the Caddyfile to a DNS-01 challenge via a Caddy DNS-provider module.)
- The Discord OAuth app needs `https://<DOMAIN>/api/auth/callback/discord` registered as a redirect URL.
- The four `HOST_*` directories must exist and be writable by uid 1001 (the app container's user).

The volume topology mirrors the storage design:

| Mount | Maps to | Put it on |
|---|---|---|
| `HOST_STORAGE_DIR` | completed files, served by Caddy at `/f/*` | the big HDD array |
| `HOST_STAGING_DIR` | in-progress tus uploads | an SSD |
| `HOST_DB_DIR` | SQLite database | SSD |
| `HOST_REPLICA_DIR` | Litestream replica | a *different* disk than the DB |

After the first deploy, run the ops smoke checks at the bottom of the [manual checklist](docs/manual-embed-checklist.md) — most importantly that a Range request against `/f/*` returns `206` (Discord video scrubbing depends on it).

### Configuration reference

| Variable | Required | Meaning |
|---|---|---|
| `DOMAIN` | ✔ | Public hostname; Caddy site address and link base (`https://$DOMAIN`) |
| `BASE_URL` | dev only | Overrides the derived base URL (e.g. `http://localhost:3000`) |
| `STORAGE_LIMIT` | ✔ | Total byte budget for stored files — raw bytes or `500GB` / `2TiB` style |
| `MAX_FILE_SIZE` | — | Global per-file cap; unset = capped by the user's quota |
| `DEFAULT_FILE_EXPIRY` | — | Default expiry for new files (`30d`, `12h`); unset = never |
| `ALLOWED_GUILD_IDS` | ✔ | Comma-separated Discord guild IDs whose members may sign in |
| `ADMIN_DISCORD_IDS` | ✔ | Comma-separated Discord user IDs with admin access |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | ✔ | Discord OAuth application credentials |
| `BETTER_AUTH_SECRET` | ✔ | Session signing secret (≥ 32 random bytes) |
| `STAGING_DIR` / `STORAGE_DIR` / `DATABASE_PATH` | ✔ | Data paths (fixed inside the containers; compose maps `HOST_*` onto them) |

## Design notes & trade-offs

- **Caddy over nginx** — automatic HTTPS and request-body streaming by default (no proxy-buffering fights with multi-GB tus PATCHes). The trade-off is losing nginx's `X-Accel-Redirect`, which doesn't matter under the capability-URL model since downloads need no application check.
- **SQLite over a DB server** — single-box deployment, metadata workload measured in kilobytes, and Litestream provides continuous off-disk replication. WAL mode + one process is well within its comfort zone.
- **Post-moderation over pre-approval** — files are shareable the second the upload finishes; review is a cleanup tool, not a gate. For a private community that's the right friction level, and deletion is instant and total when it's needed.
- **Pending uploads count, executables don't** — the review queue exists for content problems; the type policy exists for "someone's little brother clicked a `.scr`". Different threats, different mechanisms.
- The full product spec, including every resolved design question and its rationale, lives in [docs/PRD.md](docs/PRD.md).
