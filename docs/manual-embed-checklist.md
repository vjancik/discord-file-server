# Manual Discord embed checklist

Automated tests cover link resolution and OG tags, but only Discord itself can
verify how embeds render. Run through this once against the deployed instance
(real domain + HTTPS — Discord won't fetch plain http or localhost).

> Discord caches unfurls per URL server-side. When iterating on OG tags,
> upload the file again to get a fresh short code instead of re-pasting the
> same link (PRD §5).

## Media embeds (paste the `/s/…` short link in a channel)

- [ ] **MP4 video** — inline player with the thumbnail as poster; scrubbing
      works (requires Range support through Caddy).
- [ ] **Large video (> 500 MB)** — link works; note whether the client still
      inline-previews it (known platform constraint, PRD §5).
- [ ] **WebM video** — inline player (some clients fall back to a link card).
- [ ] **PNG / JPEG / GIF image** — inline image preview.
- [ ] **MP3 / OGG audio** — inline audio player.
- [ ] **Canonical URL** (`/f/<id>/<name>`) pasted directly also embeds.

## Non-media card (PRD §5)

- [ ] **ZIP or PDF** — card embed showing the original filename (extension
      included) and "size — uploaded by name".
- [ ] Clicking the link in Discord downloads the file directly
      (`Content-Disposition: attachment` from Caddy).

## Revocation

- [ ] Delete a file whose link was posted earlier — the link 404s immediately.
- [ ] Note: the thumbnail may linger in Discord's media proxy cache
      (documented, not fixable on our side).

## Mobile

- [ ] Upload page works on a phone; the copy button actually copies
      (requires HTTPS for `navigator.clipboard`).
- [ ] Video embed plays inline in the Discord mobile app.

## Ops smoke (once per deployment)

- [ ] `curl -H "Range: bytes=0-99" https://$DOMAIN/f/<id>/<name>` → `206`.
- [ ] `curl -A Discordbot https://$DOMAIN/s/<code>` → OG HTML;
      plain `curl` → `302`.
- [ ] `https://$DOMAIN/robots.txt` disallows `/f/` and `/s/`.
- [ ] Litestream replica advances after an upload (`ls` the replica path).
