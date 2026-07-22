import type { EmbedSourceRow, FileRow } from "@/db/schema";
import { formatBytes } from "@/lib/units";
import { canonicalUrl, thumbnailUrl } from "../links/urls";
import {
  escapeHtml,
  type OgFileInput,
  trimCardDescription,
} from "./og-builder";

/**
 * The Mastodon trick (docs/mastodon-trick.md), beta route: convince Discord a
 * /s_beta link is a Mastodon status so it renders description + footer + a
 * native attachment player in one embed, bypassing the OG pipeline (where
 * og:video suppresses og:description) — and, hypothesis under test, its
 * embed cache. Deliberately no EMBED_SIZE_LIMIT gating anywhere here: every
 * video gets a player attachment regardless of size.
 *
 * Reverse-engineered Discord behavior (verified against FxEmbed 2026-07-20):
 * the crawler HTML carries no og:video/og:image, only an activity+json
 * alternate link whose path Discord rewrites to GET /api/v1/statuses/<id> on
 * the same host and renders as a Mastodon status.
 */

export interface MastodonFileInput
  extends Omit<OgFileInput, "source">,
    Pick<FileRow, "createdAt"> {
  /** Full source row — the status also carries views and the source timestamp. */
  source?: Pick<
    EmbedSourceRow,
    "title" | "description" | "viewCount" | "uploadedAt"
  >;
}

export function activityStatusUrl(
  baseUrl: string,
  uploaderName: string,
  shortCode: string,
): string {
  // Only the path shape matters: Discord derives /api/v1/statuses/<id> from
  // the trailing segment; the /users/... URL itself is never a real page.
  return `${baseUrl}/users/${encodeURIComponent(uploaderName)}/statuses/${shortCode}`;
}

/**
 * Crawler HTML for Discordbot on /s_beta: FxEmbed's minimal shape — title,
 * description, site name, player card hint, and the activity+json alternate
 * that flips Discord into its Mastodon pipeline. No og:video/og:image.
 */
export function buildMastodonHtml(
  file: MastodonFileInput,
  baseUrl: string,
): string {
  const title = escapeHtml(file.source?.title ?? file.fileName);
  const description = escapeHtml(
    file.source?.description
      ? trimCardDescription(file.source.description)
      : `${formatBytes(file.sizeBytes)} — uploaded by ${file.uploaderName}`,
  );
  const activity = escapeHtml(
    activityStatusUrl(baseUrl, file.uploaderName, file.shortCode),
  );
  const canonical = escapeHtml(canonicalUrl(baseUrl, file));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta property="og:site_name" content="Discord File Server">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="twitter:card" content="player">
<link rel="alternate" type="application/activity+json" href="${activity}">
<meta name="robots" content="noindex">
</head>
<body>
<p><a href="${canonical}">${title}</a></p>
</body>
</html>`;
}

/** Media kinds Mastodon attachments can express; other kinds embed text-only. */
const ATTACHMENT_TYPES: Record<string, "video" | "image" | "audio"> = {
  video: "video",
  image: "image",
  audio: "audio",
};

function statusContent(file: MastodonFileInput): string {
  const toHtml = (text: string) => escapeHtml(text).replaceAll("\n", "<br>");
  if (!file.source) {
    return `<b>${toHtml(file.fileName)}</b><br>${toHtml(
      `${formatBytes(file.sizeBytes)} — uploaded by ${file.uploaderName}`,
    )}`;
  }
  const parts = [`<b>${toHtml(file.source.title)}</b>`];
  if (file.source.description) {
    parts.push(toHtml(trimCardDescription(file.source.description)));
  }
  if (file.source.viewCount !== null) {
    parts.push(
      `<b>👁️ ${new Intl.NumberFormat("en-US").format(file.source.viewCount)} views</b>`,
    );
  }
  return parts.join("<br><br>");
}

/**
 * Mastodon API v1 status object for GET /api/v1/statuses/<shortCode>. Fields
 * Discord renders: content (description), account (author row), created_at
 * (footer timestamp), media_attachments (native player). The rest pad the
 * shape to a plausible Mastodon status so stricter parsing doesn't bail.
 */
export function buildMastodonStatus(
  file: MastodonFileInput,
  baseUrl: string,
): Record<string, unknown> {
  const canonical = canonicalUrl(baseUrl, file);
  const thumb = thumbnailUrl(baseUrl, file);
  const createdAt = file.source?.uploadedAt ?? file.createdAt;
  const type = ATTACHMENT_TYPES[file.kind];
  const meta =
    file.width && file.height
      ? {
          original: {
            width: file.width,
            height: file.height,
            size: `${file.width}x${file.height}`,
            aspect: file.width / file.height,
          },
        }
      : {};
  return {
    id: file.shortCode,
    url: `${baseUrl}/s_beta/${file.shortCode}`,
    uri: `${baseUrl}/s_beta/${file.shortCode}`,
    created_at: createdAt.toISOString(),
    edited_at: null,
    reblog: null,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    language: "en",
    content: statusContent(file),
    spoiler_text: "",
    visibility: "public",
    sensitive: false,
    application: { name: "Discord File Server", website: null },
    account: {
      id: file.shortCode,
      display_name: file.uploaderName,
      username: file.uploaderName,
      acct: file.uploaderName,
      url: baseUrl,
      uri: baseUrl,
      avatar: `${baseUrl}/og.png`,
      avatar_static: `${baseUrl}/og.png`,
    },
    media_attachments: type
      ? [
          {
            id: file.id,
            type,
            url: canonical,
            preview_url: thumb,
            remote_url: null,
            description: file.fileName,
            meta,
          },
        ]
      : [],
    mentions: [],
    tags: [],
    emojis: [],
  };
}
