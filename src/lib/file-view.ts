import type { EmbedSourceRow, FileRow } from "@/db/schema";
import {
  canonicalUrl,
  posterUrl,
  shortUrl,
  thumbnailUrl,
  watchUrl,
} from "@/server/links/urls";

/** Serializable projection of an embed_sources row for the watch view. */
export interface EmbedView {
  title: string;
  description: string | null;
  sourceUrl: string;
  viewCount: number | null;
  uploadedAt: string | null;
  watchUrl: string;
}

/** Serializable projection of a file row for client table/preview components. */
export interface FileView {
  id: string;
  fileName: string;
  kind: FileRow["kind"];
  mimeType: string;
  sizeBytes: number;
  status: FileRow["status"];
  createdAt: string;
  shortUrl: string;
  canonicalUrl: string;
  thumbnailUrl: string | null;
  /** Larger poster for the video player; falls back to thumbnailUrl. */
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  ownerName?: string;
  deletedAt?: string | null;
  /** Present for /embed_video files — enables the watch view in previews. */
  embed?: EmbedView | null;
}

export function toFileView(
  file: FileRow & { owner?: { name: string } },
  baseUrl: string,
  source?: EmbedSourceRow | null,
): FileView {
  return {
    id: file.id,
    fileName: file.fileName,
    kind: file.kind,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    createdAt: file.createdAt.toISOString(),
    shortUrl: shortUrl(baseUrl, file),
    canonicalUrl: canonicalUrl(baseUrl, file),
    thumbnailUrl: thumbnailUrl(baseUrl, file),
    posterUrl: posterUrl(baseUrl, file),
    width: file.width,
    height: file.height,
    ownerName: file.owner?.name,
    deletedAt: file.deletedAt ? file.deletedAt.toISOString() : null,
    embed: source
      ? {
          title: source.title,
          description: source.description,
          sourceUrl: source.sourceUrl,
          viewCount: source.viewCount,
          uploadedAt: source.uploadedAt
            ? source.uploadedAt.toISOString()
            : null,
          watchUrl: watchUrl(baseUrl, file),
        }
      : null,
  };
}
