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
}

/**
 * OG page served to embed crawlers (PRD §5). Media gets player embeds
 * (og:video / og:image / og:audio pointing at the raw file — Discord renders
 * an inline player); everything else gets a card whose title is the original
 * filename and whose link direct-downloads.
 */
export function buildOgHtml(file: OgFileInput, baseUrl: string): string {
  const canonical = canonicalUrl(baseUrl, file);
  const short = shortUrl(baseUrl, file);
  const thumb = thumbnailUrl(baseUrl, file);

  const common: Array<[string, string | null | undefined]> = [
    ["og:site_name", "DiscordFileServer"],
    ["og:title", file.fileName],
    ["og:url", short],
  ];

  let specific: Array<[string, string | null | undefined]>;
  switch (file.kind) {
    case "video":
      specific = [
        ["og:type", "video.other"],
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
        [
          "og:description",
          `${formatBytes(file.sizeBytes)} — uploaded by ${file.uploaderName}`,
        ],
        ["twitter:card", "summary"],
      ];
  }

  const title = escapeHtml(file.fileName);
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
