# Capacity model: staging admission, reservations, disk-full handling

How the app guarantees that concurrent uploads can't fill the staging SSD or
the storage array, and what happens when space runs out. Implemented in
`src/server/capacity/` (ledger, disk probe, admission) and
`src/server/cleanup/staging-gc.ts` (GC + pressure eviction). Everything here
assumes the single-process deployment (Next standalone on one box, PRD §7) —
the ledger is in-memory and a second replica would break its guarantees.

## Budgets

- **`STORAGE_LIMIT`** (existing): byte budget for completed files, divided
  into per-user quotas.
- **`STAGING_LIMIT`** (new, mandatory): byte budget for the staging area.
  Every upload reserves its **full declared size** at creation time in an
  in-memory ledger, so N concurrent uploads can no longer collectively
  overrun the SSD while each individually passes its quota check.

Both budgets are *bookkeeping*. At admission time each is additionally
clipped to what the volume can physically absorb (`statfs`, `bavail`), minus
1 GiB headroom for sidecars, thumbnails, and SQLite WAL growth. A clip means
something outside the app is eating the disk (or the limit is oversized):
it's logged as a warning once per transition, and the clipped number is used
— physical reality wins over configuration.

## The reservation ledger

`StagingLedger` maps upload id → `{sizeBytes, ownerId}`.

- **Reserve**: in tus `onUploadCreate`, after every gate passes and before
  any bytes land.
- **Release**: when finalize completes or fails (the staging file is then
  gone or orphaned), when the client cancels (tus `DELETE` →
  `POST_TERMINATE`), or when GC/eviction deletes the staging files.
- **Restart**: resumed uploads PATCH an existing URL and never re-enter
  `onUploadCreate`, so at boot the ledger is rebuilt from FileStore's
  `<id>.json` sidecars (which carry the declared size and owner).
- **Self-healing**: the hourly job reconciles the ledger against the staging
  dir — a reservation whose files are gone is released, an upload on disk
  that's missing is adopted. A leaked reservation therefore costs at most one
  hour of phantom pressure, instead of requiring every release path to be
  perfect forever.

The same reservations close the quota TOCTOU race: a user's in-flight bytes
are passed as `pendingBytes` into `QuotaService.planUpload`, so two
concurrent uploads can't both pass against the same stored usage. They also
count toward a global storage backstop (live bytes + in-flight + incoming ≤
`STORAGE_LIMIT`), which catches per-user quota drift when the active-user
divisor shrinks.

## Admission decisions (tus `onUploadCreate`)

For an upload of size S, after the type policy and quota checks:

1. **Storage first**: S plus all in-flight bytes must fit the storage budget
   *and* the storage volume's physical free space (credit given for files the
   quota plan will auto-delete). Staging drains *into* storage, so waiting
   never helps a full storage volume → these failures are immediate
   **rejects** (HTTP 413) and logged as errors.
2. **Can it ever fit?** If S exceeds `min(STAGING_LIMIT, physical ceiling)`
   even with staging empty → **reject**.
3. **Does it fit now?** Reserved bytes + dead bytes + S ≤ effective limit →
   **accept**, reserve.
4. **Pressure**: eagerly evict (below), re-measure from disk. Fits now →
   **accept**.
5. **Will it fit later?** If other uploads are in flight, their draining (or
   idle eviction) will free space → **wait** (HTTP 429; the client retries).
   If nothing is draining, waiting cannot help → **reject** and log an error
   (explicit policy: never leave an upload waiting for space that will not
   arrive).

## Waiting = client retry, deliberately no FIFO

A `wait` is an HTTP 429. `@uppy/tus` reacts by pausing its request queue and
retrying on a delay schedule we configure (~10 minutes total; the schedule is
walked once per page session — see the comment in `upload-panel.tsx`). Each
retry re-runs the full admission check, so the "queue" is just polling.

**Policy call (deliberate):** there is no FIFO fairness. Small files are the
primary use case and are admitted the moment they fit, even while a large
upload waits — which can starve the large upload until its retry budget runs
out and it fails with the server's explanation. That trade-off is accepted;
the alternative (strict FIFO) would make every small upload wait behind a
queued multi-GB file.

## Pressure eviction (eager cleanup)

When admission comes up short it frees space before deciding, in two tiers:

1. **Orphans** — staging entries tus can no longer resume (data file without
   sidecar or vice versa; typically leftovers of a failed finalize or a
   crash). Deleted after a 60 s grace period regardless of age; they are dead
   bytes that would otherwise sit until the 24 h GC.
2. **Idle uploads** — in-flight uploads untouched for over an hour
   (`PRESSURE_IDLE_TTL_MS`), evicted oldest-first, only as many as needed.
   This breaks that client's resume (its next PATCH 404s and the upload
   restarts) — accepted and logged as a warning: within-session resumability
   is protected, day-long parked uploads are not, and only under pressure.

Fresh uploads are never evicted; anything mid-finalize just wrote its last
chunk and looks fresh by mtime. The regular GC still removes anything
untouched for 24 h — now pair-aware (data + sidecar judged by their newest
mtime), so a long-running upload's never-rewritten sidecar isn't collected
from under it.

## Disk-full (ENOSPC) posture

- **Prevented, mostly**: admission's physical checks reject or delay uploads
  before bytes start flowing, which is where ENOSPC would otherwise appear.
- **Monitored**: the hourly job logs a warning when either volume drops below
  2 GiB free (`LOW_DISK_WARN_BYTES`).
- **Probe order**: `node:fs` `statfs` — Bun implements it natively (verified
  on Bun 1.3), so no `df` subprocess fallback is needed.
- Same-volume caveat: the physical ceiling treats staging bytes as
  reclaimable, which assumes staging and storage sit on different volumes
  (the intended deployment). On a shared dev volume the numbers are merely
  conservative in the wrong direction; the bookkeeping limits still hold.
