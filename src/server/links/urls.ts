import type { FileRow } from "@/db/schema";

/** Canonical file URL — served by Caddy in production (PRD §4). */
export function canonicalUrl(
  baseUrl: string,
  file: Pick<FileRow, "id" | "fileName">,
): string {
  return `${baseUrl}/f/${file.id}/${encodeURIComponent(file.fileName)}`;
}

export function shortUrl(
  baseUrl: string,
  file: Pick<FileRow, "shortCode">,
): string {
  return `${baseUrl}/s/${file.shortCode}`;
}

/** Thumbnail lives alongside the file, so Caddy serves it from the same /f/ dir. */
export function thumbnailUrl(
  baseUrl: string,
  file: Pick<FileRow, "id" | "thumbnailPath">,
): string | null {
  return file.thumbnailPath ? `${baseUrl}/f/${file.thumbnailPath}` : null;
}
