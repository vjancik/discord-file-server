# `/embed_video` — PRD (v1)

Status: **finalized, ready to implement.** Auth/provisioning design lives in
[embed-auth.md](embed-auth.md). The second iteration (metadata + watch page)
is implemented — see the last section.

## Command & scope

`/embed_video url:<link>` in an allowed guild. The bot downloads the media
with yt-dlp, uploads it through the public tus endpoint as the invoking user
(provisioning them if needed), and edits its reply to the `/f/` link so
Discord shows a playable embed.

- The reply is **public** (the point is sharing) and deferred immediately.
- **Every interactive button is invoker-only**: clicks from anyone else get an
  ephemeral "Only the requester can use these buttons." The invoker's user id
  is embedded in the button `customId` alongside the job nonce.
- Playlists are refused (`--no-playlist`; if the probe still returns a
  playlist, error out). Livestreams (`is_live`) are refused.
- Concurrency: one download job at a time (in-process queue) plus a per-user
  cooldown. Queued jobs show "Waiting in queue…" and are cancellable.

## Configuration

| Env var | Meaning |
| --- | --- |
| `EMBED_SIZE_LIMIT` | Discord inline-embed threshold (default `80MB` — the nominal ~100MB is soft and observed failing as low as 96MB). Not a hard cap — larger files still upload, but the app's OG page serves them as a thumbnail card instead of og:video player tags: Discord's media proxy must cache external videos to render a player, fails unpredictably near/above the soft limit, and **caches the failure** (the link stays embedless even after metadata changes — one shot). Read by both containers; env-controlled because Discord changes this number. |
| `EMBED_SCRATCH_DIR` | Per-job download workspace. Must live on the SSD (same volume as staging). |
| `EMBED_SCRATCH_LIMIT` | Max bytes the scratch dir may hold; admission-checked before a job starts. |

Bot container gains `yt-dlp` + `ffmpeg`/`ffprobe`.

**Staging capacity is shared through the filesystem, not IPC.** The server's
staging admission already clips to the volume's *true* free space at runtime,
so bytes the bot's scratch holds automatically shrink what web-upload
admission will grant. Symmetrically, the bot checks real free space (and its
own `EMBED_SCRATCH_LIMIT`) before starting a download and **waits, abortable,
with a queue message** when space is tight — the same wait-not-fail UX as the
web uploader's 429 loop. During the upload phase the bot goes through the
actual tus staging admission, so that part shares the real queue. A unified
reservation ledger would require a server-side reservation API; deferred
until multi-host or fairness problems make it worth it.

## Codec & container policy

Goal: files that inline-play in Discord clients.

- **Embeddable = mp4 or webm container, size within `EMBED_SIZE_LIMIT`.**
  Codecs are not otherwise policed: h264, h265, vp9, av1 all embed (h265
  doesn't play on iPhones — accepted for now, refine if complaints arrive).
- Formats with *unknown* codecs in an mp4 container (e.g. Vimeo progressive)
  are treated as compatible.
- **No full re-encoding, ever.** Envelope changes are fine. Concretely:
  `--recode-video` is never passed; merging uses ffmpeg stream copy; container
  normalization uses `--merge-output-format` matched to the chosen codecs
  (mp4 for h264/aac, webm for vp9/opus). `--remux-video` semantics back this
  guarantee: an unsupported codec/container combination *fails* rather than
  silently re-encoding — such a failure surfaces as a normal job error.

## Phase 1 — probe

`yt-dlp -J --no-playlist <url>` (implies `--simulate`; metadata only, a few
seconds). Format selection happens **in our code**, not via `-f` filters
(filters can't constrain the *sum* of a video+audio pair, and silently drop
formats with unknown sizes). The chosen pair is later passed as explicit
format ids (`-f 137+140` style) so what we probed is what we fetch.

Per-format size confidence tiers (validated against real sources 2026-07):

1. **exact** — `filesize` published (YouTube DASH, most direct-mp4 hosts).
2. **approx** — `filesize_approx` (yt-dlp: avg bitrate × duration).
3. **rough** — our own `tbr × duration` for manifest (HLS/DASH) formats where
   yt-dlp deliberately abstains because manifest `tbr` can be a peak rate.
   Shown to users as "~N MB (rough)".
4. **unknown** — nothing available.

Classification is **per-format, not per-URL**: sources often mix sized and
unsized formats at the same resolution (Vimeo exposes sizeless HLS *and*
exact-size progressive mp4s) — prefer the sized sibling at equal quality.

Merged size estimate = video + audio stream sizes; measured mux overhead is
~0.3%, so the fit decision uses a ~5% safety margin on estimates (exact sums
may run to ~2% under the limit).

## Phase 2 — pre-download decision

First, resolve (or provision, per embed-auth.md) the invoker's account and
compute remaining quota (`quotaFor − usageFor` via the shared QuotaService).

- **Not enough quota for any acceptable rung** → inform (reuse `/quota`
  message style: current usage, limit, manage-files link). Stop.
- **Best quality fits `EMBED_SIZE_LIMIT`** (within margin) → proceed silently.
- **Best quality exceeds it, and a smaller rung fits** → invoker-only buttons
  with **short labels** — `Full quality` / `Fit embed` / `Cancel` — while the
  message text carries the detail ("Full: 1080p · ~780 MB (won't embed) —
  Fit: 720p · ~340 MB").
- **Best quality exceeds it, nothing fits** → `Download anyway` / `Cancel`,
  details in the message text.
- **Insufficient size info** → warn "size can't be determined — it may exceed
  the embed limit" (quoting the configured value) → `Proceed` / `Cancel`.
  Proceeding runs the best-effort path with the watchdog (below).
- Dialogue timeout: 10 minutes without a click = Cancel (cleanup, reply
  edited to say so).

Quota fit is checked against the same estimate; the uncertain tier is
best-effort: download, re-verify actual size afterwards, discard with a clear
message if it exceeds remaining quota (fail fast — the server would reject
the upload at admission anyway).

## Phase 3 — download

Into a per-job scratch dir under `EMBED_SCRATCH_DIR`, flags:
explicit `-f <ids>`, `--no-playlist`, `--newline`,
`--progress-delta 2`, `--progress-template` exposing
`progress.downloaded_bytes / total_bytes(_estimate) / speed / eta`,
`--merge-output-format` per codec choice, output template
`%(title).200B [%(id)s].%(ext)s` (title becomes the stored filename),
`--max-filesize` set to the server per-file cap when sizes are known.

**Progress:** parsed from the template stream and edited into the reply every
~2 s (progress bar, %, MB, speed, ETA). Well within Discord's ~5 edits/5 s
per-channel budget. An `Abort` button (invoker-only) kills the job.

**Watchdog (kill-over-quota — yes, it works):** downloaded bytes are known
continuously from the progress template (scratch-dir `du` as fallback for
postprocess phases). If bytes exceed the remaining-quota snapshot, the scratch
limit, or the user-confirmed size choice by a wide factor, SIGKILL the yt-dlp
process group and delete partials. `--max-filesize` alone is insufficient (it
only aborts sizes known up front, per stream, not merged sums) — the watchdog
is the real enforcement. `ENOSPC` from yt-dlp/ffmpeg is treated the same:
kill, delete partials, friendly "the server ran out of scratch space" reply.

**The 15-minute interaction-token limit:** Discord webhooks behind an
interaction (the deferred reply and its edits) expire after 15 min. Most jobs
finish well inside that. If a job is still running near expiry (~14 min), the
bot posts a **regular channel message** ("continuing here…") and moves
progress/dialogues to it — bot-authored messages are editable indefinitely and
support buttons, and each button click opens a fresh 15-min window.
Consequence: the bot needs **Send Messages** in channels where `/embed_video`
is used (document in the invite/permissions section of the README when
implementing).

## Phase 4 — post-download verification (pre-upload, on scratch)

ffprobe the actual file: size vs `EMBED_SIZE_LIMIT`, container, codecs.
This runs on **every** route — even confident estimates get verified, and it
catches mishaps (estimate undershoot, unexpected codec).

- **Embeddable** → proceed to upload.
- **Expected over-limit** (the user already chose a version known to exceed
  the embed limit) → upload without re-asking: their pre-download click was
  the confirm, and one confirm suffices.
- **Unexpected failure** (fits/unknown-size routes coming out over, or a
  container surprise) → invoker-only dialogue: `Keep` / `Delete`. Keep →
  upload anyway (the link still works as a file page); a "won't inline-embed"
  note is appended only when the reply is the channel's first disclosure
  (the silent fits route). Delete → discard scratch, say so. Timeout
  10 min = Delete.
- **Over remaining quota** (uncertain-size route) → inform + discard. No
  dialogue — there's no valid "keep" outcome.

**Design decision — why the check is pre-upload:** running verification on the
scratch file *before* the tus upload dissolves the user-in-the-middle problem
entirely. Finalize stays untouched and never waits on a human; in the normal
path there is nothing to delete post-finalize, and the `/f/` link only comes
into existence after the user's "keep". The upload service token therefore
stays **upload-only** — no delete scope needed. For post-finalize edge cases
(late abort during upload, future needs) the bot already has an authorized
delete path: the same `FileService` it uses for review rejections, naturally
scoped because the bot only ever passes the file id it just created, with the
tombstone attributed to the invoker's user id.

## Phase 5 — upload

tus upload with the service token (embed-auth.md), which flows through the
normal staging admission — so `/embed_video` **shares staging limits and
queueing with web uploads by design** (this is the reason scratch lives on
the same SSD class: the copy into staging is SSD→SSD). Queued state shows
"Waiting for staging space…" in the reply; `Abort` cancels the tus upload
(server already handles late-cancel races). The finalize pipeline applies
unchanged; the file lands `pending` and the existing review announcer posts
it to the admin channel — intended behavior.

Final reply edit: the bare `/s/` short URL (the embed renders from the server's
OG tags; the short link is also where the metadata iteration will hang the
title/description card). Scratch dir is deleted in a `finally`, plus an
orphan sweep at bot startup (covers crashes mid-job; in-memory job state is
lost on restart and the stale reply is accepted for v1).

## Errors

yt-dlp failures can't be enumerated — sanitize and pass through:

1. Take the meaningful tail (`ERROR:` lines first, else last stderr lines),
   strip ANSI escapes.
2. Wrap every URL in `<>` (suppresses embeds).
3. Truncate to fit the reply. Note: Discord message **content** caps at
   2,000 characters (4,096 only applies to embed descriptions) — budget
   ~1,800 for the error body.

A small allowlist of recognizable cases (unsupported URL, geo-restriction,
login required, livestream) gets friendlier one-liners; everything else is
the sanitized passthrough.

## Races & edge cases

- Abort during download → kill process group, cleanup. Abort during upload →
  cancel tus; server late-cancel handling exists.
- Admin rejects/deletes the pending file right after upload → `/f/` link dies;
  tombstone deletion is idempotent; no bot-side handling needed.
- Same user re-invoking while a job runs → cooldown + queue position message.
- Bot restart mid-job → orphaned scratch swept at boot; reply goes stale
  (accepted for v1).

## Second iteration — metadata & watch page (implemented)

Embed files carry their source metadata end to end:

- **Storage:** `embed_sources` table (fileId PK → files, cascades with the
  row): raw probe `title`, `description` (nullable), `webpage_url` (falls
  back to the invoked URL), plus nullable `view_count` and `uploaded_at`
  (probe `timestamp`, else `upload_date`) shown YouTube-style on the watch
  page when present. Written by the bot **directly into the
  shared SQLite DB** right after the tus upload finalizes, *before* the reply
  is posted — so a crawler unfurling the fresh link never races the metadata.
  A failed save is logged and never eats the link (card degrades to the
  filename). Web uploads have no row and keep first-iteration behavior.
- **OG card (`/s/<code>`):** `og:title` is the source title; `og:description`
  is the source description trimmed to the first 3 `\n+`-separated paragraphs
  or 280 chars, whichever is less (word-boundary cut + ellipsis — Discord
  truncates embed descriptions itself around ~350 chars). Player-vs-thumbnail
  logic unchanged. Note: Discord deliberately hides `og:description` when it
  renders an inline video player (same as YouTube links) — the description
  shows on thumbnail cards (over-limit videos) and on other platforms. The
  only known workaround is undocumented Discord behavior; investigated and
  written down in [mastodon-trick.md](mastodon-trick.md), not adopted.
- **Watch page (`/v/<code>`):** human visitors to `/s/` of an embed file are
  302'd here instead of the raw file. Wears the shared site header
  (`SiteHeader`: full nav when signed in, Sign in button + theme toggle when
  not) and the app's `max-w-6xl` frame. Layout, YouTube-style: inline player
  (poster = thumbnail) → title → left-aligned button row (`Short URL` /
  `File URL` copy buttons — the raw `/f/` URL is otherwise unreachable for
  embed files — `Download`, and `Original URL` external link) → full
  untrimmed description in a muted card, newlines preserved, long URLs
  wrapped (`wrap-anywhere`). Public and noindexed, same liveness rules as
  `/s/`; `/v/` of a non-embed file redirects to the raw file.
- **Dashboard preview:** the files-table preview dialog renders the same
  `WatchView` component as `/v/` for files with an `embed_sources` row
  (plus a "Full View" link to the page); plain uploads keep the bare media
  preview. The watch layout lives only in
  `src/components/files/watch-view.tsx`.
