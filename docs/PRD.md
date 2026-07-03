# PRD — Discord Upload Server

A self-hosted file upload and sharing service for a Discord community, built to get around
Discord's upload limits. Users authenticate with Discord, upload large files through a web UI,
and receive links that embed correctly (image/video/audio players) when pasted into Discord.

**Status:** draft for review — see [Open Questions](#open-questions) before implementation.

---

## 1. Goals

- Let authorized Discord users upload files far beyond Discord's size limits.
- Produce share links that unfurl/embed properly in Discord — inline video player, image
  preview, audio player — whether pasted as the short link or the canonical URL.
- Give users a dashboard to view, share, and delete their own uploads.
- Give admins a review queue and a global file browser with moderation actions.
- Run entirely on a homelab box (HDD array for storage, SSD for staging, 10 Gbps uplink).

### Non-goals

- Public signup or federation — access is gated to specific Discord guild(s).
- CDN/multi-node scaling. Single box. Cloudflare can be layered in front later without
  rearchitecting.
- End-to-end encryption or per-download authorization (see [Security model](#7-security-model)).

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Next.js 15** (App Router, self-hosted `next start`) | One app: upload page, dashboards, admin, auth, short-link redirects, OG pages |
| Language | TypeScript everywhere | |
| Auth | **Better Auth** with Discord social login | Scopes: `identify`, `guilds` |
| Database | **SQLite + Drizzle ORM** | Litestream for continuous backup |
| Edge / TLS | **Caddy** | Automatic HTTPS; serves file bytes directly; reverse-proxies everything else to Next.js |
| Uploads | **tus** resumable protocol — `@tus/server` mounted in Next.js, **Uppy Dashboard** (`@uppy/react` + `@uppy/tus`) in the browser | Caddy streams request bodies (no nginx-style buffering fights) |
| Media probing | **ffprobe/ffmpeg** in the upload-complete hook | Duration, dimensions, thumbnail/poster generation |
| UI | **Tailwind v4 + shadcn/ui**, lucide-react, sonner | |
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

Control plane vs. data plane: Node handles logic, Caddy handles bytes. JS is never in the
download path.

```
                        ┌─────────────────────────────────────────┐
 Discord clients ──────▶│ Caddy (TLS)                             │
 Browsers        ──────▶│                                         │
                        │  /f/*  ──▶ file_server (HDD array)      │   data plane
                        │  everything else ──▶ reverse_proxy      │
                        └───────────────┬─────────────────────────┘
                                        ▼
                        ┌─────────────────────────────────────────┐
                        │ Next.js (localhost:3000)                │   control plane
                        │  auth · upload page · dashboards ·      │
                        │  admin · /s/* redirects & OG pages ·    │
                        │  tus endpoint                           │
                        └───────────────┬─────────────────────────┘
                                        ▼
                          SQLite (metadata) · SSD staging ──mv──▶ HDD array
```

### Upload flow

1. Browser: Uppy Dashboard → tus resumable chunks → `@tus/server` endpoint (Better Auth
   session checked in tus hooks).
2. In-progress uploads are written to an **SSD staging directory** (chunked appends are
   unkind to HDDs).
3. On completion: ffprobe extracts dimensions/duration, ffmpeg generates a thumbnail,
   the file is **moved (sequential write) to the HDD array**, and a DB row is created
   with status per the review-queue policy.

### Download flow

Caddy serves `/f/*` straight from disk — Range requests, ETags, conditional GETs out of the
box (Range support is required for Discord video scrubbing). Next.js never sees download
traffic.

---

## 4. URL scheme

| URL | Behavior |
|---|---|
| `files.<domain>/f/<file-id>/<original-name.ext>` | Canonical. Bytes served by Caddy. Extension in path + correct `Content-Type` for reliable Discord embeds. |
| `<domain>/s/<short-code>` | Short link, resolved by Next.js. UA-dependent (below). |

- `file-id`: 128-bit random, URL-safe (e.g. 22-char base64url). Unguessable by design.
- `short-code`: short random code, unique per share link.
- Never set `Content-Disposition: attachment` on media types — it kills Discord embeds.
- Never serve `application/octet-stream` for known media types.

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

Known platform constraints (accepted, not solvable on our side):

- Playable **iframe** embeds (YouTube-style) are limited to Discord's hardcoded domain
  allowlist — not available to us. `og:video` → raw mp4 gives an inline player anyway.
- Discord caches unfurls per URL server-side: iterate on OG tags with fresh short codes.
- Very large media may not inline-preview in some clients even when the link works.
  **Test with a >500 MB video early.**
- Deleting a file does not retract thumbnails already cached by Discord's media proxy.

## 6. Features

### Upload page (authenticated users)

- Uppy Dashboard: drag-drop, multi-file, per-file progress, pause/resume, retry, previews.
- On completion, show canonical + short link with copy buttons.

### User dashboard

- Table of own uploads: thumbnail, name, size, type, upload date, review status, link(s).
- Actions: copy link, generate/regenerate short link, preview (native `<video>`/`<img>` in a
  dialog, thumbnail as poster), delete (kills all links immediately).

### Admin dashboard

- **Review queue**: pending uploads with inline preview; approve / reject, bulk actions
  via row selection.
- **All-files browser**: global TanStack Table across users — sort/filter by user, type,
  size, date, status; delete; view as user would.
- Admin-only route group guarded by Better Auth session + admin check in the layout.

### Authorization

- Sign-in: Discord OAuth (Better Auth), scopes `identify` + `guilds`.
- Access gate: user's guild list must intersect the configured allowed guild ID(s).
- Admin: determination method TBD (see Open Questions).
- Role-level restrictions within a guild would require a bot token to query guild member
  roles (OAuth scopes alone don't expose roles) — only if needed.

## 7. Security model

**Capability URLs, not per-download auth.** The unguessable 128-bit file ID *is* the
credential — the same model as Discord's own CDN. Rationale (settled during design):

- A redirect necessarily hands the client the final URL; "accessible only via redirect"
  is not an enforceable property.
- CORS governs JS reads, not media loads or navigation — it is not access control.
- Referer/Origin checks break the actual use case (Discord hotlinking the file **is** the
  product) and are trivially spoofable.
- Signed expiring URLs (S3-style) would break old Discord embeds, which re-fetch from
  origin indefinitely.

What we do instead:

- **Revocation is the control**: deleting a file or rotating its ID from the dashboard kills
  every shared link instantly.
- `X-Robots-Tag: noindex` on `/f/*` + `robots.txt` disallow — keeps leaked links out of
  search engines (the realistic exposure vector).
- No directory listing (Caddy `file_server` without `browse`).
- Upload endpoint and all dashboards require an authenticated, guild-authorized session.

## 8. Storage & ops

- **Staging**: SSD directory for in-progress tus uploads; move to HDD array on completion.
- **Layout**: content-addressed-ish flat layout under the array mount, e.g.
  `/mnt/storage/uploads/<file-id>/<original-name.ext>` (maps 1:1 to the `/f/*` URL path).
- **DB backup**: Litestream replicating SQLite (target TBD).
- **File backup**: out of scope for v1 (homelab array policy applies).
- Serving a handful of concurrent streams from HDDs is well within capability; Discord's
  media proxy additionally caches embedded images.

---

## Open questions

Decisions needed before implementation:

1. **Review queue semantics** — are `pending` files immediately linkable/downloadable
   (flagged, post-moderated) or quarantined (404 until approved)? Do admins/trusted users
   skip the queue (auto-approve)?
2. **Admin determination** — hardcoded Discord user ID list in config? A Discord role
   (requires bot token)? DB flag toggled by a seed admin?
3. **Guilds** — single guild or multiple from day one? Where are allowed guild IDs
   configured (env var vs. admin UI)?
4. **Limits & quotas** — max file size per upload? Per-user total storage quota? Allowed
   file types (multimedia only, or any file, e.g. zips)?
5. **Short links** — auto-generated per file by default, or created on demand? Custom
   vanity slugs? One short code per file or many?
6. **Retention** — do files ever expire? Cleanup policy for rejected files and abandoned
   (incomplete) tus uploads?
7. **Domains** — one hostname for everything, or app + `files.` subdomain split (the PRD
   assumes the split)? What are the actual domain names?
8. **Deployment shape** — Docker Compose (Next.js + Caddy + Litestream) vs. bare
   systemd units? Node LTS or Bun as the runtime?
9. **Audio support** — in scope for v1? (Direct links to `audio/*` embed a player in
   Discord; effort is small.)
10. **Anonymous viewing confirmation** — confirm that anyone holding a file URL (no
    Discord login) can download it. This is inherent to the capability-URL model and
    required for embeds, but stating it explicitly.
11. **Naming** — project/app name (shows up in OG titles, repo, service names).
