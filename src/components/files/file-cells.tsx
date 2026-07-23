"use client";

import {
  FileIcon,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { FileView } from "@/lib/file-view";

/**
 * Locale-formatted timestamp without an SSR hydration mismatch: the server
 * (and first client render) show a deterministic UTC string; the viewer's
 * locale/timezone rendering swaps in after mount.
 */
export function DateCell({ iso }: { iso: string }) {
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => setLocal(new Date(iso).toLocaleString()), [iso]);
  return (
    <span title={iso}>
      {local ?? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`}
    </span>
  );
}

export function KindIcon({ kind }: { kind: FileView["kind"] }) {
  const cls = "size-4 text-muted-foreground";
  switch (kind) {
    case "video":
      return <Film className={cls} />;
    case "image":
      return <ImageIcon className={cls} />;
    case "audio":
      return <Music className={cls} />;
    default:
      return <FileText className={cls} />;
  }
}

/** 40px thumbnail if one exists, kind icon otherwise. */
export function ThumbCell({ file }: { file: FileView }) {
  if (file.thumbnailUrl && !file.deletedAt) {
    return (
      // biome-ignore lint/performance/noImgElement: next/image would proxy file bytes through Next — Caddy owns the data plane (PRD §3)
      <img
        src={file.thumbnailUrl}
        alt=""
        className="h-10 w-14 rounded object-cover"
        loading="lazy"
      />
    );
  }
  return (
    <div className="flex h-10 w-14 items-center justify-center rounded bg-muted">
      {file.deletedAt ? (
        <FileIcon className="size-4 text-muted-foreground" />
      ) : (
        <KindIcon kind={file.kind} />
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: FileView["status"] }) {
  return status === "approved" ? (
    <Badge variant="secondary">approved</Badge>
  ) : (
    <Badge variant="outline">pending</Badge>
  );
}
