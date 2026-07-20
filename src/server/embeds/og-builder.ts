import type { FileRow } from "@/db/schema";
import { formatBytes } from "@/lib/units";
import { canonicalUrl, shortUrl, thumbnailUrl } from "../links/urls";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function metaTags(
  pairs: Array<[property: string, content: string | null | undefined]>,
): string {
  return pairs
    .filter((pair): pair is [string, string] => Boolean(pair[1]))
    .map(
      ([property, content]) =>
        `<meta property="${property}" content="${escapeHtml(content)}">`,
    )
    .join("\n");
}

export interface OgFileInput
  extends Pick<
    FileRow,
    | "id"
    | "fileName"
    | "mimeType"
    | "sizeBytes"
    | "kind"
    | "shortCode"
    | "width"
    | "height"
    | "thumbnailPath"
  > {
  uploaderName: string;
  /** /embed_video source metadata; when present the card carries the real title. */
  source?: { title: string; description: string | null };
}

const CARD_DESCRIPTION_MAX_CHARS = 280;
const CARD_DESCRIPTION_MAX_PARAGRAPHS = 3;

/**
 * Source descriptions can be enormous (YouTube allows 5k chars); the card gets
 * the first 3 paragraphs or 280 chars, whichever is less — Discord truncates
 * unfurl descriptions itself not far past that. The watch page shows the full
 * text. Trims at a word boundary and ellipsizes when anything was dropped.
 */
export function trimCardDescription(text: string): string {
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  let out = paragraphs.slice(0, CARD_DESCRIPTION_MAX_PARAGRAPHS).join("\n");
  let cut = paragraphs.length > CARD_DESCRIPTION_MAX_PARAGRAPHS;
  if (out.length > CARD_DESCRIPTION_MAX_CHARS) {
    const sliced = out.slice(0, CARD_DESCRIPTION_MAX_CHARS);
    const boundary = Math.max(
      sliced.lastIndexOf(" "),
      sliced.lastIndexOf("\n"),
    );
    // Keep a mid-token cut over losing most of the text to one long token.
    out = (
      boundary > CARD_DESCRIPTION_MAX_CHARS / 2
        ? sliced.slice(0, boundary)
        : sliced
    ).trimEnd();
    cut = true;
  }
  return cut ? `${out}…` : out;
}

/**
 * OG page served to embed crawlers (PRD §5). Media gets player embeds
 * (og:video / og:image / og:audio pointing at the raw file — Discord renders
 * an inline player); everything else gets a card whose title is the original
 * filename and whose link direct-downloads.
 *
 * Videos above `embedLimit` deliberately get the card treatment instead of
 * player tags: Discord's media proxy must cache external videos to render a
 * player, fails unpredictably above its soft limit, and caches the failure —
 * an og:video tag there risks a permanently embedless link, while a thumbnail
 * card always unfurls.
 */
export function buildOgHtml(
  file: OgFileInput,
  baseUrl: string,
  embedLimit: number,
): string {
  const canonical = canonicalUrl(baseUrl, file);
  const short = shortUrl(baseUrl, file);
  const thumb = thumbnailUrl(baseUrl, file);
  const description = file.source?.description
    ? trimCardDescription(file.source.description)
    : `${formatBytes(file.sizeBytes)} — uploaded by ${file.uploaderName}`;

  const common: Array<[string, string | null | undefined]> = [
    ["og:site_name", "Discord File Server"],
    ["og:title", file.source?.title ?? file.fileName],
    ["og:url", short],
  ];

  let specific: Array<[string, string | null | undefined]>;
  switch (file.kind) {
    case "video":
      specific =
        file.sizeBytes > embedLimit
          ? [
              ["og:type", "website"],
              ["og:description", description],
              ["og:image", thumb],
              ["twitter:card", thumb ? "summary_large_image" : "summary"],
            ]
          : [
              ["og:type", "video.other"],
              ["og:description", file.source ? description : null],
              ["og:video", canonical],
              ["og:video:secure_url", canonical],
              ["og:video:type", file.mimeType],
              ["og:video:width", file.width?.toString()],
              ["og:video:height", file.height?.toString()],
              ["og:image", thumb],
              ["twitter:card", "player"],
            ];
      break;
    case "image":
      specific = [
        ["og:type", "website"],
        ["og:image", canonical],
        ["og:image:type", file.mimeType],
        ["og:image:width", file.width?.toString()],
        ["og:image:height", file.height?.toString()],
        ["twitter:card", "summary_large_image"],
      ];
      break;
    case "audio":
      specific = [
        ["og:type", "music.song"],
        ["og:audio", canonical],
        ["og:audio:secure_url", canonical],
        ["og:audio:type", file.mimeType],
      ];
      break;
    default:
      // Non-media card (PRD §5): filename as title, size + uploader as
      // description; clicking through direct-downloads the file.
      specific = [
        ["og:type", "website"],
        ["og:description", description],
        ["twitter:card", "summary"],
      ];
  }

  const title = escapeHtml(file.source?.title ?? file.fileName);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
${metaTags([...common, ...specific])}
<meta name="robots" content="noindex">
</head>
<body>
<p><a href="${escapeHtml(canonical)}">${title}</a></p>
</body>
</html>`;
}
