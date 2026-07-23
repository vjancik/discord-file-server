# Current limitations & maturity gaps

Honest self-assessment of the v1 implementation (2026-07). The core architecture
(control/data-plane split, capability URLs, SQLite, post-moderation) is settled
and defensible; the gaps below are what separates it from a robust, mature
project. Ordered lists within each section are roughly by severity.

## Correctness / concurrency (highest priority)

- [x] **Quota check is a TOCTOU race.** Fixed: in-flight uploads are reserved
      in an in-memory staging ledger and passed into `planUpload` as
      `pendingBytes`, so concurrent uploads check against committed + pending
      usage (see `docs/capacity.md`).
- [x] **No cap on in-flight staging bytes.** Fixed: mandatory `STAGING_LIMIT`
      + full-size reservations at creation; uploads that don't fit wait (429
      retry) or fail fast (see `docs/capacity.md`).
- [x] **No `busy_timeout` pragma on SQLite.** Two concurrent writes (e.g. two
      uploads finalizing simultaneously) can throw `SQLITE_BUSY` and fail a
      finalize whose bytes were already moved. Fixed: `busy_timeout = 5000`
      in `src/db/client.ts` (also unbroke the Docker build, where page-data
      workers raced the WAL pragma on a fresh db file).
- [ ] **Short-code collision is not retried.** The unique index catches the
      collision but the insert just throws (500 + orphaned storage dir). The
      implementation plan specified retry-on-unique-violation; it was never
      written. 48 bits makes this rare, not impossible.
- [ ] **Orphaned storage dirs on crash.** SIGTERM/crash between "bytes moved to
      storage" and "DB row inserted" leaves an orphaned `<file-id>/` dir that
      nothing garbage-collects (staging GC only covers the staging dir).

## Architecture

- [ ] **Unbounded queries / no pagination.** `listAllWithOwner()` loads every
      row ever into a server component and ships it to the client table. Same
      for the user dashboard. First thing to fall over as data grows.
- [ ] **Authorization drift within session lifetime.** The guild gate runs only
      at session creation — a user kicked from the Discord server keeps access
      until the session expires (days). No admin "revoke user sessions" action
      exists.
- [ ] **No rate limiting anywhere** — auth endpoints (Better Auth's built-in
      limiter isn't enabled), tus creation, `/s/` resolution.
- [ ] **tus CORS is default-open** (`Access-Control-Allow-Origin: *`).
      Credentialed requests save it in practice, but `allowedOrigins` should be
      pinned to the deployment domain.
- [ ] **Better Auth logs bypass pino** — the library writes raw console lines;
      its logger option is not wired into the centralized logger.
- [ ] **Sync SQLite on the request path** is a deliberate trade-off
      (single-box, tiny metadata workload) but is undocumented as one; every
      repository call blocks the event loop.
- [ ] **No error boundaries** — no `error.tsx` / custom `not-found.tsx`;
      failures render Next's default chrome.
- [x] `respectForwardedHeaders: true` trusts client-supplied `X-Forwarded-*`
      if the app port is ever reachable without Caddy in front. Resolved: the
      option was removed — tus upload URLs are now minted from the configured
      `baseUrl` (`generateUrl`), never from request headers.

## Embed fidelity (Discord-side ceilings, confirmed in beta 2026-07)

- [ ] **No embed renditions for oversized video or audio.** Confirmed against
      live Discord: videos above ~100 MB embed as a card without a player
      (Discord's media pipeline declines large files; threshold undocumented),
      and `og:audio` is ignored entirely — external links never get an audio
      player, only native uploads do. Both are fixable with upload-time
      renditions in `finalize.service.ts`: a capped-bitrate preview for
      oversized videos, and an audio-only mp4/webm wrapper for audio files
      (Discord's embed video player plays audio-only containers). Store like
      thumbnails (`previewPath` alongside `thumbnailPath`), point `og:video`
      at the rendition, keep `/f/` serving the original. Costs: transcode CPU
      at finalize time (background it or accept slower publish for big files)
      and extra storage per rendition.

## Testing

- [ ] **No CI.** Nothing runs typecheck/lint/tests/e2e on push. This is the
      single highest-leverage gap: it converts all existing quality work into
      *visible* quality.
- [ ] **tus hook chain has no integration test** below the e2e level —
      `onUploadCreate` gate ordering, auto-delete execution path, error-shape
      mapping. (The plan called for this; it wasn't written.)
- [ ] **Hand-rolled Range parser in the `/f` fallback route has zero unit
      tests** — classic off-by-one territory.
- [ ] `/s/` route handler logic (expiry check, UA branch) only covered via e2e.
- [ ] **E2e covers happy paths only**: no pause/resume, no over-quota
      rejection, no auto-delete flow, no expiry.
- [ ] No coverage reporting; no a11y assertions (axe); no visual regression.

## Deployment / ops

- [ ] **No health endpoint** and no compose `healthcheck`s.
- [x] **Disk-full (ENOSPC) is unmonitored and unhandled.** Fixed: admission
      clips both budgets to physical free space (`statfs`) before any bytes
      flow, and the hourly job logs low-disk warnings (see `docs/capacity.md`).
      Remaining gap: a mid-PATCH ENOSPC (disk consumed by something outside
      the app inside the headroom margin) still surfaces as a generic tus
      write error rather than a classified one.
- [ ] **No restore runbook.** Litestream replicating is half a backup; an
      untested restore is not a backup. Default replica target is a path on the
      same box.
- [ ] No log rotation (pino → docker's unbounded json-file driver), no resource
      limits in compose.
- [ ] No image publishing (registry), no versioning/tags, no release process;
      single-arch build; no build cache mounts (every image build reinstalls
      dependencies from scratch).
- [ ] Litestream races the app on first boot (DB file doesn't exist yet);
      restart policy papers over it.
- [ ] Graceful shutdown unverified (in-flight finalize on SIGTERM; cleanup
      `setInterval` never cleared).

## Open-source / portfolio table stakes

- [ ] **No LICENSE** (legally unusable by anyone else as-is).
- [ ] No screenshots / demo GIF in the README.
- [ ] No CONTRIBUTING.md, SECURITY.md, issue templates, changelog, CI badge.
- [ ] Single squashed history (per-phase commits were skipped) — reviewers
      can't follow the build-up.

## Divergences from stated instructions / spec

- Better Auth's own **testing utilities were not used** (AGENTS.md asked for
  mocking capabilities of cross-cutting libraries); unit tests insert user rows
  directly and e2e uses an env-gated (`E2E_TEST_AUTH=1`) email/password path.
- PRD stack table lists **react-hook-form + zod for forms** — never used;
  settings ended up as switches calling server actions directly. Reconcile the
  PRD rather than leaving the drift ambient.
- "Integration tests for major modules" — the upload endpoint (arguably *the*
  major module) has only e2e coverage (see Testing).

## Suggested resolution order (one focused day)

1. **CI workflow** (typecheck + biome + `bun test` + Playwright) with a badge —
   highest leverage, makes everything else verifiable.
2. **Remaining concurrency hole**: short-code insert retry (`busy_timeout`
   and the quota reservation are done).
3. **LICENSE + two screenshots** in the README.
4. **`/healthz` route + compose healthchecks + pagination** on the admin and
   dashboard queries.

Then, in a second pass: rate limiting + tus `allowedOrigins`, the missing tus
integration test + Range parser tests, restore runbook, log rotation, and an
admin session-revocation action.
