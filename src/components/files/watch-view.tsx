"use client";

import { Download, ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import type { EmbedView, FileView } from "@/lib/file-view";

/**
 * Watch view for /embed_video files: player, source title (YouTube-style,
 * below the player), link buttons, stats line and full description in a muted
 * card. The single implementation behind both the /v watch page and the
 * dashboard preview dialog — layout/content changes belong here.
 */
export function WatchView({
  file,
  embed,
  titleTag: TitleTag = "h1",
}: {
  file: FileView;
  embed: EmbedView;
  /** "h2" when rendered inside a dialog that already has a heading. */
  titleTag?: "h1" | "h2";
}) {
  const aspectRatio =
    file.width && file.height ? `${file.width} / ${file.height}` : "16 / 9";

  // YouTube-style "1,299,168 views · May 17, 2026"; parts absent when the
  // source didn't expose them. UTC keeps date-only publish dates exact.
  const stats = [
    embed.viewCount !== null
      ? `${new Intl.NumberFormat("en-US").format(embed.viewCount)} views`
      : null,
    embed.uploadedAt
      ? new Intl.DateTimeFormat("en-US", {
          dateStyle: "medium",
          timeZone: "UTC",
        }).format(new Date(embed.uploadedAt))
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {file.kind === "audio" ? (
        // biome-ignore lint/a11y/useMediaCaption: source media has no caption tracks
        <audio
          controls
          preload="metadata"
          src={file.canonicalUrl}
          className="w-full"
        />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: source media has no caption tracks
        <video
          controls
          playsInline
          preload="metadata"
          src={file.canonicalUrl}
          poster={file.posterUrl ?? undefined}
          className="max-h-[70svh] w-full rounded-lg bg-black object-contain"
          style={{ aspectRatio }}
        />
      )}
      <TitleTag className="text-balance font-semibold text-xl">
        {embed.title}
      </TitleTag>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton value={file.shortUrl} label="Short URL" />
        <CopyButton value={file.canonicalUrl} label="File URL" />
        {/* Same-origin /f/ URL without Content-Disposition, so the download
            attribute is honored (see DownloadFileButton). */}
        <Button asChild variant="outline" size="sm">
          <a href={file.canonicalUrl} download={file.fileName}>
            Download
            <Download />
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={embed.sourceUrl}>
            Original URL
            <ExternalLink />
          </a>
        </Button>
      </div>
      {(stats || embed.description) && (
        <div className="flex flex-col gap-1 rounded-xl bg-muted/50 p-4 text-sm">
          {stats && <p className="font-medium">{stats}</p>}
          {embed.description && (
            <p className="wrap-anywhere whitespace-pre-wrap">
              {embed.description}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
