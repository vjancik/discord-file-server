# `/embed` auth: user provisioning & upload service tokens

Status: **designed, not implemented** — companion to the `/embed` entry in
[planned.md](planned.md). Resolves its "Ownership/auth" open question. Written
for later review; revisit the Scaling section before any multi-host move.

## Goal

Files created by `/embed` must be owned by the invoking Discord user — counted
against their quota and visible in their dashboard — even if they have never
signed in to the web UI. When they later authenticate for the first time, they
must land in the account that already owns those files.

## Part 1 — Proactive provisioning ("fake-registering")

Better Auth resolves OAuth sign-ins by looking up `account` on
`providerId + accountId` **before** considering user creation; pre-existing
rows are first-class (this is how its official NextAuth migration works). So
the bot can mint real accounts ahead of time.

**Mechanism.** When `/embed` is invoked by a Discord user with no
`account (providerId='discord', accountId=<discordId>)` row, the bot inserts:

- `user`: `id = crypto.randomUUID()`, `name` from the interaction user,
  `email = "<discordId>@discord.placeholder.local"`, `emailVerified = false`,
  optionally `image` from the avatar CDN URL.
- `account`: `providerId 'discord'`, `accountId = <discordId>`, `userId` →
  the new user, all tokens `null`.

On first real sign-in the OAuth callback finds the account row, refreshes its
tokens, and creates a session for the linked user. Dashboard, quota, and
`/quota` all resolve through the same rows with no further work.

**Why it is safe in this codebase specifically:**

- The placeholder email exactly matches what `mapProfileToUser` in
  `src/auth/auth.ts` synthesizes, and `overrideUserInfo` is off, so sign-in
  never rewrites the email — no collision path.
- The guild gate (`session.create.before` hook) reads the Discord access token
  from the account row; the OAuth callback stores fresh tokens **before**
  session creation, so a provisioned account (tokens `null`) passes the gate
  normally on first sign-in. The bot side is consistent by construction:
  slash commands only exist in `ALLOWED_GUILD_IDS`.

**Required migration:** a unique index on `account (provider_id, account_id)`.
It does not exist today; it makes provisioning race-safe (insert-or-ignore
instead of check-then-insert) against a concurrent first web sign-in, and it
matches Better Auth's implied semantics anyway.

**Profile freshness:** `overrideUserInfoOnSignIn: true` is enabled on the
Discord provider (src/auth/auth.ts), so every sign-in refreshes `name`,
`image`, and `email` from Discord. For provisioned accounts this corrects the
embed-time username on first sign-in. Interplay checks:

- Placeholder emails are stable: `mapProfileToUser` feeds the override, and it
  synthesizes the *same* `<discordId>@discord.placeholder.local` the bot
  minted — the update is a no-op until Discord actually returns an email
  (i.e. `REQUIRE_EMAIL` is turned on), at which point the placeholder
  upgrades to the real address, as intended.
- `emailVerified` is preserved when the email is unchanged (Better Auth
  compares before overwriting).
- Edge: if the real email already exists on a *different* user row, the
  unique constraint fails the update and the sign-in errors. Only reachable
  with `REQUIRE_EMAIL` on and one person owning two Discord accounts —
  acceptable; surfaces loudly rather than corrupting.

## Part 2 — Upload service token

Provisioning answers *ownership*; the bot still needs to push bytes through
the public tus endpoint **as** that user. It must not write `STORAGE_DIR` or
`files` rows directly (see planned.md — the finalize pipeline must apply).

**Token shape.** Minted by the bot per upload, HMAC-SHA256 over a compact
payload:

```
{ userId, exp, jti, maxBytes? }
```

- `userId` — the (possibly just-provisioned) owner. Inside the signed payload,
  so tampering invalidates the signature: an outsider cannot upload into
  another user's account without the secret.
- `exp` — short TTL (~15 min: yt-dlp + upload). Small leeway (~30 s) for
  clock skew, which matters once hosts are separate (see Scaling).
- `jti` — random UUID, single-use. The server records accepted `jti`s until
  their `exp` passes and rejects reuse, so even a captured token cannot be
  replayed. Store: DB table from day one (see Scaling), pruned by `exp`.
- `maxBytes` (optional) — belt-and-braces per-upload cap.

**Secret.** A dedicated `BOT_SERVICE_SECRET` in the shared `.env` (generate
like `BETTER_AUTH_SECRET`). Known only to the app and bot containers; never
appears in any client-visible response. Rotation: accept `current, previous`
(comma-separated) during a rotation window so the two containers need not
restart atomically.

**Verification rules (server side, tus admission hook only):**

1. Timing-safe signature check against each configured secret.
2. `exp` in the future (with leeway); `jti` unseen. **Consumption point:**
   tus is multi-request (create, then PATCHes), so the `jti` is consumed at
   *upload creation*, after admission passes — a 429 "wait" retry does not
   burn it. Non-create requests verify signature + expiry only; they can't
   start new uploads, and reaching an existing one requires its unguessable
   upload URL.
3. The token is honored **only** for tus upload admission. It is never
   exchanged for a session or cookie and is rejected on every other endpoint.
   Blast radius of a leaked secret = upload-as-user, strictly less than the
   bot's existing raw DB/storage access.

**Transport.** Bot → server over the internal Docker network (or TLS edge);
the token never reaches end users.

**Test checklist:** forged signature; expired; tampered `userId`; replayed
`jti`; second secret accepted during rotation; token rejected outside the tus
hook.

## Part 3 — Scaling challenges (recorded now, revisit before scaling)

**Multi-host (bot and Next.js on separate machines):**

- The token itself is fine — stateless HMAC, only the secret must be shared
  (now across two machines' env management, rotate accordingly).
- The real blocker is **shared SQLite**: provisioning, `DbIdentity`, the
  review loop, and the `jti` store all assume direct DB access. Split hosts
  means moving those behind small server APIs authenticated by the same
  service secret (e.g. `POST /api/service/provision`), or replacing SQLite.
  That is a substantial refactor; the token design survives it unchanged.
- Clock skew becomes real; the `exp` leeway covers it.

**Horizontal Next.js (multiple app nodes):**

- The `jti` store **must** be shared (DB), not per-node memory — a per-node
  set would allow one replay per node. This is why the design says DB table
  from day one; it costs little now and removes the trap.
- Concurrent migration runs from multiple app nodes are a pre-existing
  concern (app owns migrations), not introduced by this design.
- Quota admission races across nodes are likewise pre-existing (SQLite
  serializes writers; a different DB would need its own transactional check).

**Sharded bot hosts (multiple bot instances):**

- Provisioning stays safe: the unique index makes concurrent provisioning of
  the same user a no-op on one side.
- `jti` uniqueness is trivially preserved (random UUIDs).
- The review tick loop assumes a single instance — two bots would double-post
  announcements. Sharding requires leader election or per-guild partitioning;
  out of scope here but recorded.
- Interactive `/embed` state (e.g. the quality-choice dialogue holding a probe
  result between message and button click) must either live in the DB or use
  gateway sharding so the same instance receives the button interaction.
