# Current limitations & maturity gaps

Honest self-assessment of the v1 implementation (2026-07). The core architecture
(control/data-plane split, capability URLs, SQLite, post-moderation) is settled
and defensible; the gaps below are what separates it from a robust, mature
project. Ordered lists within each section are roughly by severity.

## Correctness / concurrency (highest priority)

- [ ] **Quota check is a TOCTOU race.** `QuotaService.planUpload` reads current
      usage, then the upload proceeds independently — two concurrent uploads can
      both pass the check and both land, exceeding quota. Needs a
      transaction/reservation around check-and-create.
- [ ] **No cap on in-flight staging bytes.** N parallel uploads, each within
      quota, can still fill the staging SSD. Quota only counts *completed*
      files.
- [ ] **No `busy_timeout` pragma on SQLite.** Two concurrent writes (e.g. two
      uploads finalizing simultaneously) can throw `SQLITE_BUSY` and fail a
      finalize whose bytes were already moved. One pragma in
      `src/db/client.ts` fixes it.
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
- [ ] `respectForwardedHeaders: true` trusts client-supplied `X-Forwarded-*`
      if the app port is ever reachable without Caddy in front.

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
- [ ] **Disk-full (ENOSPC) is unmonitored and unhandled** — the most realistic
      homelab failure mode; nothing alerts or degrades gracefully.
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
2. **The three concurrency holes**: `busy_timeout` pragma, short-code insert
   retry, transaction/reservation around quota-check-and-create.
3. **LICENSE + two screenshots** in the README.
4. **`/healthz` route + compose healthchecks + pagination** on the admin and
   dashboard queries.

Then, in a second pass: rate limiting + tus `allowedOrigins`, the missing tus
integration test + Range parser tests, restore runbook, log rotation, and an
admin session-revocation action.
