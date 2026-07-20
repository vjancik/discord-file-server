# The Mastodon trick — description + footer + video player in one Discord embed

Status: **investigated, not implemented.** We're staying on documented OG
behavior for now; this file preserves the findings (verified live 2026-07-20
against fxtwitter) so the route can be picked up later without re-discovery.

## The problem it solves

Discord's OG pipeline makes description and video player mutually exclusive:
an `og:video` player card **suppresses `og:description`** (same as YouTube
links — title + player only), while a card that shows the description can't
play video. Our `/s/` embed cards therefore show no description for
inline-playable videos, and nothing OG-shaped can change that.

fxtwitter/FxEmbed embeds show tweet text **and** a playable video **and** a
"FxTwitter · <timestamp>" footer simultaneously. They do it by bypassing OG
entirely: per their own source comment — *"Convince Discord that you are
actually a Mastodon link lol"*.

## Mechanism (verified against the live service)

For requests whose User-Agent contains `Discordbot` (gated by their
`Experiment.ACTIVITY_EMBED`), the crawler HTML contains **no `og:video` /
`og:image` at all**. Only `og:title`, `og:description`, `og:site_name`,
`twitter:card: player`, and two alternate links:

```html
<link rel="alternate" type="application/json+oembed"
      href="https://fxtwitter.com/owoembed?text=<stats>&status=<id>&author=<handle>&provider=<stats>">
<link rel="alternate" type="application/activity+json"
      href="https://fxtwitter.com/users/<handle>/statuses/<snowcode>">
```

1. **oEmbed** returns `{ author_name: "💬 4 🔁 342 ❤️ 3.2K 👁️ 51.0K", ... }` —
   Discord renders the oEmbed author text as the stats row.
2. **ActivityPub link** is the payload: a Mastodon-shaped status URL. The
   `<snowcode>` is their own encoding of the status id + render flags
   (`src/helpers/snowcode.ts`), *not* the raw tweet id.
3. Discord sees the `activity+json` alternate and switches to its **native
   Mastodon embed pipeline**: it calls the site's Mastodon REST API,
   `GET /api/v1/statuses/<snowcode>`, on the same host. (No nodeinfo /
   .well-known / WebFinger required — FxEmbed implements only this one
   endpoint plus the HTML link.)
4. The endpoint returns a **Mastodon API v1 status** object. Fields Discord
   renders:
   - `content` — HTML text (`<br>` for newlines, links/mentions as `<a>`,
     stats line appended in `<b>`) → the embed **description**
   - `account.display_name` / `.username` / `.avatar` → the **author row**
   - `created_at` (ISO) → the **footer timestamp**, next to the site branding
   - `application.name` — the posting app (not the footer branding)
   - `media_attachments: [{ type: "video", url: <direct mp4>,
     preview_url: <thumbnail>, meta: { original: { width, height, size,
     aspect } } }]` → rendered as a Mastodon **attachment player**, which is
     why it coexists with the description (it is not an OG player card)

Captured live response (trimmed) for a real tweet:

```json
{
  "content": "There's a secret \"Ado Mode\" on Remix 8 of Rhythm Heaven!!<br><br><b><a href=\"...\">💬</a> 4 <a href=\"...\">🔁</a> 342 ...</b>",
  "created_at": "2026-07-16T15:21:31.000Z",
  "application": { "name": "Twitter Web App", "website": null },
  "account": { "display_name": "makoyaki ...", "username": "makoyakii", "avatar": "https://pbs.twimg.com/..." },
  "media_attachments": [{
    "type": "video",
    "url": "https://api.fxtwitter.com/2/go?url=https%3A%2F%2Fvideo.twimg.com%2F...",
    "meta": { "original": { "width": 1280, "height": 720, "size": "1280x720", "aspect": 1.777 } }
  }]
}
```

Notes from their implementation (`src/embed/status.ts`,
`src/embed/activity.ts` in FxEmbed/FxEmbed):

- The activity path is emitted **only for Discordbot UA**; other crawlers get
  conventional embeds. It's also skipped when the only media is an external /
  broadcast stream URL (attachment must be a directly fetchable file).
- Newlines inside `content` are `\n` → `<br>︀︀` (with invisible U+FE00
  variation selectors appended — presumably spacing workarounds in Discord's
  renderer).
- Video URLs can be behind a redirect (their `/2/go?url=` wrapper); Discord's
  media proxy follows it.
- `/users/<handle>/statuses/<snowcode>` itself just 302s browsers to their
  GitHub — only the derived `/api/v1/statuses/` call matters.

## How we'd implement it (if ever)

Everything hangs off data we already store (`embed_sources` + `files`):

1. On the `/s/[code]` crawler response, when the UA is Discordbot (subset of
   `isEmbedCrawler`) and the file has an `embed_sources` row, add:
   `<link rel="alternate" type="application/activity+json"
   href="<base>/users/<uploaderName>/statuses/<shortCode>">` and drop the
   `og:video` tags from that response (Discord ignores them in this mode
   anyway; other crawlers keep the current page).
2. New route `GET /api/v1/statuses/[code]`: resolve the short code (same
   liveness rules as `/s/`), return Mastodon-shaped JSON:
   - `content`: source title/description as escaped HTML with `<br>`
     newlines; could carry the views/date line
   - `account`: uploader name (or "via <source domain>"); avatar optional
   - `created_at`: `embed_sources.uploadedAt` (or file `createdAt`)
   - `media_attachments`: one `video` with `url` = canonical `/f/` URL,
     `preview_url` = thumbnail URL, `meta.original` from probed
     width/height
   - The id namespace is our short code — no snowcode-style encoding needed
     since we carry no render flags.
3. Keep it behind an env flag with the current OG page as fallback, so a
   Discord-side change degrades to today's behavior.

## Caveats / why we haven't done it

- **Undocumented, reverse-engineered Discord behavior.** Discord can change
  its Mastodon detection or rendering at any time with no notice; FxEmbed
  ships it behind an experiment flag for the same reason.
- The embed changes character: Mastodon-style author row + footer instead of
  the current site-card look; attachment-player size behavior (vs. our
  `EMBED_SIZE_LIMIT` soft-limit handling for og:video) is untested for large
  files and would need its own probing.
- Unknown interaction with Discord's embed cache — a bad first render may
  stick per URL (same failure mode as og:video over the size limit).
