# Planned features

Ideas that are agreed on in principle but not yet scheduled. Each entry should
say what the feature does, the intended shape of the implementation, and any
constraints discovered while discussing it — enough that implementation can
start without re-deriving the design.

## Discord bot: `/embed` — universal video embedder

**What:** A `/embed url:<link>` slash command (working name; possibly
`/embed_video`). The bot passes the URL to `yt-dlp`, uploads the resulting
media file to the upload server, and replies with the file's `/f/` link so
Discord unfurls a native playable embed. Effectively a universal embedder for
most video platforms yt-dlp supports (YouTube, Twitter/X, TikTok, Reddit, …).

**Flow:**

1. User invokes `/embed url:…` in an allowed guild. Bot defers the reply
   (yt-dlp is slow) — visible, not ephemeral, since the point is sharing.
2. Bot shells out to `yt-dlp` with a size cap (`--max-filesize`, derived from
   the server's per-file limits), an output template into a scratch dir, and a
   sane format preference (mp4/h264 first for embed compatibility).
3. Bot uploads the file to the server, then replies with the `/f/` URL
   (embed comes from the server's existing OG tags). Failures edit the
   deferred reply with the yt-dlp error summary.

**Key design decision — upload through the front door, not the back:** the bot
must NOT write into `STORAGE_DIR` or insert `files` rows directly. It should
upload via the public tus endpoint as a normal authenticated client, so the
whole finalize pipeline applies for free: type policy, executable sniff,
ffprobe metadata, thumbnail generation, staging admission, and quota checks.
Direct storage writes from the bot stay limited to the reject-delete case in
the review flow (which reuses `FileService`).

**Open questions to settle at implementation time:**

- **Ownership/auth:** whose quota do embedded files count against? Options:
  (a) map the invoking Discord user to their upload-server account (they must
  have signed in at least once) and mint a scoped upload credential for them —
  most honest quota-wise; (b) a dedicated "embed bot" service user with its own
  quota slice — simpler, but shared quota is abusable. Leaning (a) with (b) as
  fallback for users who never signed in. Either way the tus endpoint needs a
  server-side way to authenticate the bot (e.g. a bot-issued session via Better
  Auth, or a signed service token checked in the tus hook) — this is the one
  place a small server-side addition is expected.
- **Review status:** embedded uploads land as `pending` like everything else
  and show up in the admin review channel. Probably fine; revisit if noisy.
- **Expiry:** consider a shorter default expiry for embeds (they're
  share-and-forget) — maybe an `EMBED_FILE_EXPIRY` env var.
- **Runtime:** `yt-dlp` (and ffmpeg for remuxing) must be installed in the bot
  container; downloads should go to a bounded scratch volume, cleaned up after
  upload, with one-at-a-time or small-N concurrency to protect bandwidth/disk.
- **Abuse limits:** per-user cooldown and a max duration/filesize flag so one
  command can't pin the box.
