import type { FileRow } from "@/db/schema";
import { canonicalUrl, shortUrl, thumbnailUrl } from "@/server/links/urls";

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
  ownerName?: string;
  deletedAt?: string | null;
}

export function toFileView(
  file: FileRow & { owner?: { name: string } },
  baseUrl: string,
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
    ownerName: file.owner?.name,
    deletedAt: file.deletedAt ? file.deletedAt.toISOString() : null,
  };
}
