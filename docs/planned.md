# Planned features

Ideas that are agreed on in principle but not yet scheduled. Each entry should
say what the feature does, the intended shape of the implementation, and any
constraints discovered while discussing it — enough that implementation can
start without re-deriving the design.

## Discord bot: `/embed_video` — universal video embedder

**Design finalized — see [embed-video.md](embed-video.md) (PRD: probe →
dialogue → download → verify → upload flow, size/codec policy, quota
watchdog, error handling) and [embed-auth.md](embed-auth.md) (user
provisioning + upload service token).**

One-line summary: `/embed_video url:<link>` downloads media with yt-dlp
(remux only, never re-encode), uploads it through the public tus endpoint as
the invoking user, and replies with the `/f/` link so Discord shows a
playable embed — a universal embedder for most platforms yt-dlp supports.

Still open (settle at implementation time):

- **Expiry:** consider a shorter default expiry for embeds (they're
  share-and-forget) — maybe an `EMBED_FILE_EXPIRY` env var.
- **Review noise:** embedded uploads land `pending` and show in the admin
  review channel like everything else. Probably fine; revisit if noisy.
