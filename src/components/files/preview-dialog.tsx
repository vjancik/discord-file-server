"use client";

import { ExternalLink, Eye } from "lucide-react";
import { WatchView } from "@/components/files/watch-view";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { FileView } from "@/lib/file-view";
import { formatBytes } from "@/lib/units";

export function FilePreview({ file }: { file: FileView }) {
  switch (file.kind) {
    case "video":
      return (
        // biome-ignore lint/a11y/useMediaCaption: user uploads have no caption tracks
        <video
          src={file.canonicalUrl}
          poster={file.thumbnailUrl ?? undefined}
          controls
          className="max-h-[70vh] w-full rounded-md bg-black"
        />
      );
    case "image":
      return (
        // biome-ignore lint/performance/noImgElement: next/image would proxy file bytes through Next — Caddy owns the data plane (PRD §3)
        <img
          src={file.canonicalUrl}
          alt={file.fileName}
          className="max-h-[70vh] w-full rounded-md object-contain"
        />
      );
    case "audio":
      return (
        // biome-ignore lint/a11y/useMediaCaption: user uploads have no caption tracks
        <audio src={file.canonicalUrl} controls className="w-full" />
      );
    default:
      return (
        <div className="flex flex-col gap-2 py-4 text-sm">
          <p className="text-muted-foreground">
            {file.mimeType} · {formatBytes(file.sizeBytes)}
          </p>
          <p>
            No inline preview for this type.{" "}
            <a href={file.canonicalUrl} className="underline">
              Download {file.fileName}
            </a>
          </p>
        </div>
      );
  }
}

/**
 * Preview modal: files with embed metadata get the full watch view (same
 * implementation as the /v page) plus a "Full View" link to it; everything
 * else gets the plain media preview.
 */
export function PreviewDialog({ file }: { file: FileView }) {
  const embed = file.embed;
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Preview ${file.fileName}`}
            >
              <Eye />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Preview</TooltipContent>
      </Tooltip>
      {/* min() keeps the viewport gutter that the plain 3xl cap would drop
          between the sm breakpoint and 800px. */}
      <DialogContent className="sm:max-w-[min(48rem,calc(100%-2rem))]">
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-2 pr-8">
            <DialogTitle className="min-w-0 wrap-anywhere leading-snug">
              {file.fileName}
            </DialogTitle>
            {embed && (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="ml-auto shrink-0"
              >
                <a href={embed.watchUrl}>
                  Full View
                  <ExternalLink />
                </a>
              </Button>
            )}
          </div>
        </DialogHeader>
        {embed ? (
          <WatchView file={file} embed={embed} titleTag="h2" />
        ) : (
          <div className="min-w-0">
            <FilePreview file={file} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
