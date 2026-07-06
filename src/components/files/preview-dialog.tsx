"use client";

import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

export function PreviewDialog({ file }: { file: FileView }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Preview ${file.fileName}`}
        >
          <Eye />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{file.fileName}</DialogTitle>
        </DialogHeader>
        <FilePreview file={file} />
      </DialogContent>
    </Dialog>
  );
}
