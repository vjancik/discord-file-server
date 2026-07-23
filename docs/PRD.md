# PRD — Discord File Server

A self-hosted file upload and sharing service for a Discord community, built to get around
Discord's upload limits. Users authenticate with Discord, upload large files through a web UI,
and receive links that embed correctly (image/video/audio players) when pasted into Discord.

**Status:** iteration 3 — all open questions resolved; ready for implementation planning.

---

## 1. Goals

- Let authorized Discord users upload files far beyond Discord's size limits.
- Produce share links that embed properly in Discord — inline video player, image
  preview, audio player — whether pasted as the short link or the canonical URL.
- Give users a dashboard to view, share, and delete their own uploads.
- Give admins a review queue and a global file browser with moderation actions.
- Run entirely on a homelab box (HDD array for storage, SSD for staging, 10 Gbps uplink).

### Non-goals

- Public signup or federation — access is gated to specific Discord guild(s).
- CDN/multi-node scaling. Single box. Cloudflare can be layered in front later without
  rearchitecting.
- End-to-end encryption or per-download authorization (see [Security model](#8-security-model)).

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Next.js 16.2** (App Router, standalone output) | ⚠️ Breaking changes vs. training data — read `node_modules/next/dist/docs/` before coding (per AGENTS.md). One app: upload page, dashboards, admin, auth, short-link redirects, OG pages |
| Runtime / tooling | **Bun** (instead of node & npm) | Also builds and runs the standalone Next.js output |
| Language | TypeScript everywhere | |
| Auth | **Better Auth** with Discord social login | Scopes: `identify`, `guilds` |
| Database | **SQLite + Drizzle ORM** | Litestream for continuous backup |
| Edge / TLS | **Caddy** | Automatic HTTPS; serves file bytes directly; reverse-proxies everything else to Next.js |
| Uploads | **tus** resumable protocol — `@tus/server` mounted in Next.js, **Uppy Dashboard** (`@uppy/react` + `@uppy/tus`) in the browser | Caddy streams request bodies (no nginx-style buffering fights) |
| Media probing | **ffprobe/ffmpeg** in the upload-complete hook | Duration, dimensions, thumbnail/poster generation |
| Logging | Centralized logger — **pino** | Single logger module injected/imported everywhere; no stray `console.log` |
| Lint/format | **Biome** | Scripts copied from `discord-worldclock-bot` (see implementation notes) |
| UI | **Tailwind v4 + shadcn/ui**, lucide-react, sonner | Verify current shadcn/Next.js setup docs at implementation time |
| Tables | **TanStack Table** (shadcn DataTable pattern) | User dashboard + admin file list / review queue |
| Forms | react-hook-form + zod | zod schemas shared with server actions |
| Data layer | Server Components + Server Actions + `revalidatePath` | No TanStack Query initially; add only if optimistic/live UI is needed later |

### Explicitly rejected

- **Separate Hono/Bun link-resolver or upload service** — link resolution is one indexed DB
  lookup; the heavy work is byte transfer, which is Caddy's job, not a second Node service.
- **UploadThing** — hosted storage service (files live on their CDN at `*.ufs.sh`, storage-based
  pricing, no self-host / BYO-storage). Defeats the purpose of owning the hardware.
- **nginx** — Caddy chosen for automatic HTTPS and default request-body streaming. Trade-off
  accepted: no `X-Accel-Redirect` equivalent, which is fine under the capability-URL model.
- **Object storage (R2/S3/MinIO)** — local disk is the point of the homelab deployment.

---

## 3. Architecture

Control plane vs. data plane: the app handles logic, Caddy handles bytes. JS is never in the
download path.

```
                        ┌─────────────────────────────────────────┐
 Discord clients ──────▶│ Caddy (TLS, {$DOMAIN})                  │
 Browsers        ──────▶│                                         │
                        │  /f/*  ──▶ file_server (HDD array)      │   data plane
                        │  everything else ──▶ reverse_proxy      │
                        └───────────────┬─────────────────────────┘
                                        ▼
                        ┌─────────────────────────────────────────┐
                        │ Next.js standalone (Bun, :3000)         │   control plane
                        │  auth · upload page · dashboards ·      │
                        │  admin · /s/* redirects & OG pages ·    │
                        │  tus endpoint                           │
                        └───────────────┬─────────────────────────┘
                                        ▼
                          SQLite (metadata) · SSD staging ──mv──▶ HDD array
```

### Code architecture (per AGENTS.md)

- Modular, testable code favoring DI patterns (hexagonal-lite: services with injected
  repositories/adapters) for business logic — quota engine, review workflow, link
  resolution, media probing — without dragging that ceremony into frontend components.
- Centralized logger module; all server-side logging goes through it.

### Upload flow

1. Browser: Uppy Dashboard → tus resumable chunks → `@tus/server` endpoint (Better Auth
   session + quota check in tus hooks).
2. In-progress uploads are written to an **SSD staging directory** (chunked appends are
   unkind to HDDs).
3. On completion: ffprobe extracts dimensions/duration, ffmpeg generates a thumbnail,
   the file is **moved (sequential write) to the HDD array**, a DB row is created with
   status `pending`, and a short link is auto-generated.
4. UI shows the short link with a copy-to-clipboard button (must work on mobile —
   `navigator.clipboard` requires a secure context, which HTTPS provides).

### Download flow

Caddy serves `/f/*` straight from disk — Range requests, ETags, conditional GETs out of the
box (Range support is required for Discord video scrubbing). Next.js never sees download
traffic.

### Cleanup

- **Abandoned/failed tus uploads**: staging directory is garbage-collected (stale partial
  uploads past a TTL are deleted from disk).
- **Deleted files** (user delete or admin delete): file removed from disk, all links dead
  immediately. The DB row is kept as a **tombstone** (uploader, filename, size, timestamps,
  deleted-by) for admin accountability — bytes are gone, the record isn't.
- **Expiry**: per-file expiry exists in the schema and cleanup job; the default comes from
  an env var (`DEFAULT_FILE_EXPIRY`, unset = never). **No user-facing expiry UI in v1.**

---

## 4. URL scheme

One hostname for everything (path-based split; domain configurable via env var):

| URL | Behavior |
|---|---|
| `{DOMAIN}/f/<file-id>/<original-name.ext>` | Canonical. Bytes served by Caddy. Extension in path + correct `Content-Type` for reliable Discord embeds. |
| `{DOMAIN}/s/<short-code>` | Short link, resolved by Next.js. UA-dependent (below). |

- `file-id`: 128-bit random, URL-safe (e.g. 22-char base64url). Unguessable by design.
- `short-code`: short random code, auto-generated at upload time.
- Never set `Content-Disposition: attachment` on **media** types — it kills Discord embeds.
  Non-media files are the opposite: serve them **with** `Content-Disposition: attachment`
  so clicking the link downloads directly.
- Never serve `application/octet-stream` for known media types.

**Env-configurable domain + Caddy HTTPS**: no conflict. The Caddyfile reads the site address
from an env placeholder (`{$DOMAIN}`); Let's Encrypt provisioning only requires that DNS for
that domain points at the box and ports 80/443 are reachable. (If the box can't expose
80/443, the fallback is the DNS-01 challenge via a Caddy DNS-provider module — deployment
detail, not an architecture change.)

## 5. Discord embed strategy

Two mechanisms, both supported:

1. **Direct media links** — Discord's crawler follows 301/302 redirects and embeds based on
   the final response's `Content-Type` (`image/*`, `video/mp4`, `audio/*` → inline player).
   So `/s/<code>` → 302 → canonical URL embeds correctly with zero extra work.
2. **OG-tagged HTML (the InstaFix/fxtwitter trick)** — `/s/<code>` sniffs the User-Agent:
   - `Discordbot` → tiny HTML page with `og:title`, `og:video` (+ `og:video:type`,
     `og:video:width/height` — Discord sizes the player from these), `og:image` thumbnail,
     `twitter:card`.
   - Everyone else → 302 to the canonical file URL.

   This yields rich embeds (title, uploader, thumbnail) instead of a bare player. The ffprobe
   metadata and thumbnails from the upload hook feed both the OG tags and the dashboard UI.

Audio is **in scope for v1**: direct links to `audio/*` embed an inline player in Discord.

**Non-media files** (archives, documents, …) can't embed as players; they get the OG-card
treatment instead: `/s/<code>` serves Discordbot an OG page with `og:title` = original
filename (extension included) and `og:description` = size/uploader, producing a card embed.
Humans clicking the link get a direct download (302 to the canonical URL, which serves
non-media with `Content-Disposition: attachment`).

### File type policy

- **Multimedia** (video/image/audio): allowed, embeds as inline player/preview.
- **Other non-executable files** (archives, documents, etc.): allowed, embeds as a card
  with a direct-download link.
- **Executables: blocked at upload** — validated by extension blocklist (`.exe`, `.msi`,
  `.bat`, `.cmd`, `.sh`, `.apk`, …) plus sniffed MIME type, not just the client-reported
  type. Exact blocklist is an implementation detail with a sensible default.

Known platform constraints (accepted, not solvable on our side):

- Playable **iframe** embeds (YouTube-style) are limited to Discord's hardcoded domain
  allowlist — not available to us. `og:video` → raw mp4 gives an inline player anyway.
- Discord caches embeds per URL server-side: iterate on OG tags with fresh short codes.
- Very large media may not inline-preview in some clients even when the link works.
  **Test with a >500 MB video early.**
- Deleting a file does not retract thumbnails already cached by Discord's media proxy.

## 6. Features

### Upload page (authenticated users)

- Uppy Dashboard: drag-drop, multi-file, per-file progress, pause/resume, retry, previews.
- On successful upload: short link shown with a **copy button** (mobile-compatible).
- Uploads blocked (with clear messaging) when the user is over quota — see
  [Quota](#7-storage-quota--ops) — or when the file type is executable (§5 file type policy).

### User dashboard

- Table of own uploads: thumbnail, name, size, type, upload date, review status, link(s).
- Actions: copy link, preview (native `<video>`/`<img>` in a dialog, thumbnail as poster),
  delete.
- **Delete confirmation dialog** with a "don't show this again" checkbox; the opt-out is a
  per-user setting applying to that dialog globally (dashboard *and* admin views), and can
  be re-enabled from user settings.
- **User settings**: "Auto-delete oldest files to free quota" (Enable / Disable, default
  Disable), re-enable delete confirmations, quota usage display.

### Admin dashboard

- **Review queue** (files with status `pending`): inline/one-click **preview is the primary
  interaction** — filenames won't be descriptive enough, so previewing must be effortless
  (e.g. click row → preview dialog with media player, or an always-visible preview pane).
  Non-media files show filename, type, and size instead of a player. Actions per file:
  **Approve** or **Delete** (no separate "reject" state). Bulk approve via row selection.
  Delete uses the same confirmation dialog + global opt-out.
- **All-files browser**: global TanStack Table across users — sort/filter by user, type,
  size, date, status; delete; preview.
- Admin-only route group guarded by Better Auth session + admin check in the layout.

### Review model

- Statuses: `pending` → `approved`. **Pending files are fully live** — links work and embed
  immediately; review is post-moderation, and the only enforcement action is deletion.
- Deletion (by user or admin) kills all links immediately.

### Authorization

- Sign-in: Discord OAuth (Better Auth), scopes `identify` + `guilds`.
- Access gate: user's guild list must intersect `ALLOWED_GUILD_IDS` (env/config list).
- Admins: Discord user IDs in `ADMIN_DISCORD_IDS` (env/config list). No admin UI for
  managing either list in v1.
- Role-level restrictions within a guild would require a bot token to query guild member
  roles (OAuth scopes alone don't expose roles) — out of scope unless needed.

## 7. Storage, quota & ops

### Storage

- **Staging**: SSD directory for in-progress tus uploads; move to HDD array on completion.
- **Layout**: flat layout under the array mount, e.g.
  `/mnt/storage/uploads/<file-id>/<original-name.ext>` (maps 1:1 to the `/f/*` URL path).
- **DB backup**: Litestream replicating SQLite (target TBD).
- **File backup**: out of scope for v1 (homelab array policy applies).

### Quota model

- Global cap: `STORAGE_LIMIT` env var (total bytes the app may use for completed files).
- **Per-user quota is dynamic**: `STORAGE_LIMIT / active_users`, recomputed at upload time.
  **Active user = a user with ≥ 1 stored file** (not time-based; per-user quota extensions
  are deferred to a later iteration). If the active-user count grows or `STORAGE_LIMIT`
  shrinks, users over the new quota simply can't upload until they delete old files
  (existing files are never force-deleted by the system itself).
- **Auto-delete oldest** (per-user opt-in setting): when an upload would exceed the user's
  quota, the user's own oldest files — **by upload date, regardless of review status** —
  are deleted until the new upload fits. When disabled (default), the upload is rejected
  with an over-quota error instead.
- **Max single-file size** defaults to the user's current quota; an optional `MAX_FILE_SIZE`
  env var sets a stricter global per-file cap when defined.
- Quota check runs in the tus pre-create hook (upload size is known up front from tus
  metadata), so oversized uploads fail fast rather than at 100%.

### Deployment

- **Docker Compose**: Next.js standalone build in its own container (built and run with
  Bun), Caddy container, Litestream sidecar/container. Standalone Docker setup copied from
  `../node-aws-terraform-example` `apps/web` (see implementation notes).
- Volumes: HDD array mount (files), SSD staging dir, SQLite path.
- Config via env: `DOMAIN`, `STORAGE_LIMIT`, `MAX_FILE_SIZE` (optional),
  `DEFAULT_FILE_EXPIRY` (optional, unset = never), `ALLOWED_GUILD_IDS`,
  `ADMIN_DISCORD_IDS`, Discord OAuth credentials, staging/storage paths.

## 8. Security model

**Capability URLs, not per-download auth.** The unguessable 128-bit file ID *is* the
credential — the same model as Discord's own CDN. Rationale (settled during design):

- A redirect necessarily hands the client the final URL; "accessible only via redirect"
  is not an enforceable property.
- CORS governs JS reads, not media loads or navigation — it is not access control.
- Referer/Origin checks break the actual use case (Discord hotlinking the file **is** the
  product) and are trivially spoofable.
- Signed expiring URLs (S3-style) would break old Discord embeds, which re-fetch from
  origin indefinitely.

> **Note:** anyone holding a file URL can download the file without logging in. This is
> inherent to the capability-URL model and required for Discord embeds to work.

What we do instead:

- **Revocation is the control**: deleting a file kills every shared link instantly.
- `X-Robots-Tag: noindex` on `/f/*` + `robots.txt` disallow — keeps leaked links out of
  search engines (the realistic exposure vector).
- No directory listing (Caddy `file_server` without `browse`).
- Upload endpoint and all dashboards require an authenticated, guild-authorized session.

## 9. Design & UX

- **Dark theme first.** A light/dark toggle is nice-to-have; it does *not* need to respect
  system preference.
- Tone: **not too "gamery," not flashy** — casual, clean, functional. Density and clarity
  over decoration (this is a utility used mid-conversation from Discord).
- shadcn/ui theming (CSS variables) makes dark-first + optional toggle cheap; pick a
  restrained palette and keep motion minimal.

## 10. Testing strategy (per AGENTS.md)

| Level | Scope | Tooling (proposed) |
|---|---|---|
| Unit | Non-trivial business logic & data transformations: quota engine, auto-delete-oldest resolution, short-code/file-id generation, OG tag builder, UA sniffing, filename/content-type mapping | `bun test` |
| Integration | Major modules & repositories: Drizzle repositories against a real temp SQLite file, tus hook chain (auth → quota → staging → finalize → DB row), cleanup jobs | `bun test` + temp dirs/DBs |
| Component | Dashboard tables, review queue, delete-confirmation dialog (incl. "don't show again"), upload page states | Testing Library (once major UI parts exist) |
| E2E | Critical flows: login gate → upload → copy link → link resolves/embeds (UA-sniffed) → delete kills link; admin approve/delete | Playwright (after major UI is implemented) |

- Use **mock data factories** and the mocking/testing capabilities of cross-cutting
  libraries — notably Better Auth's testing utilities for session/user mocking — instead of
  hand-rolled auth bypasses.
- DI-style modules (section 3) exist precisely so business logic tests need no HTTP server
  or real Discord API; the Discord guild-membership check gets a fake adapter.
- Component/e2e tests are written **after** the major UI parts are implemented, per
  AGENTS.md — unit/integration tests accompany the code from the start.
- Additional unit-test targets from resolved decisions: file-type policy (executable
  blocklist + MIME sniffing), non-media OG card builder, quota divisor (active-user
  counting), auto-delete-oldest ordering, tombstone semantics.

---

## Resolved decisions (iteration 1)

| # | Decision |
|---|---|
| 1 | Pending files are live immediately; review actions are **Approve / Delete** only. Preview must be effortless in the queue. Delete has a confirmation dialog with global "don't show again" opt-out. |
| 2 | Admins: hardcoded Discord user ID list in env/config. |
| 3 | Guilds: allowed guild ID list in env/config. No management UI in v1. |
| 4 | Dynamic per-user quota = `STORAGE_LIMIT / active_users`; over-quota users can't upload until they delete. Per-user opt-in "auto-delete oldest files to free quota". |
| 5 | Short links auto-generated at upload; copy button on success (mobile-compatible). |
| 6 | Failed/abandoned uploads are deleted from disk (staging GC). File expiry implemented but defaults to "never". |
| 7 | One hostname, path-based split (`/f/*` files, `/s/*` short links). Domain from env var; compatible with Caddy auto-HTTPS. |
| 8 | Docker Compose; standalone Next.js in a container; Bun as runtime. |
| 9 | Audio embeds in scope for v1. |
| 10 | Public-URL disclaimer added to Security model (§8). |
| 11 | Name: **Discord File Server**. |

## Resolved decisions (iteration 2)

| # | Decision |
|---|---|
| 1 | Active user (quota divisor) = user with ≥ 1 stored file. Not time-based; per-user quota extensions deferred. |
| 2 | Auto-delete removes oldest files by upload date, regardless of review status. |
| 3 | Per-file max = user's current quota; optional `MAX_FILE_SIZE` env var as a global cap. |
| 4 | All non-executable file types allowed. Multimedia embeds as player; other files embed as an OG card (original filename incl. extension) whose link direct-downloads. Executables blocked at upload. |
| 5 | Deletes keep tombstone DB rows for audit; bytes are removed. |
| 6 | Testing stack confirmed: `bun test` (unit/integration), Testing Library (components), Playwright (e2e). |
| 7 | Logger: pino. |
| 8 | No user-configurable expiry; `DEFAULT_FILE_EXPIRY` env var only (unset = never). |

## Open questions

None blocking. Remaining items are implementation details to be decided in code review
rather than product decisions: exact executable blocklist contents, OG-card wording, and
staging-GC TTL for abandoned uploads.
