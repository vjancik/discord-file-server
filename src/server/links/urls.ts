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

/** Watch page for /embed_video files — human destination of /s links with source metadata. */
export function watchUrl(
  baseUrl: string,
  file: Pick<FileRow, "shortCode">,
): string {
  return `${baseUrl}/v/${file.shortCode}`;
}

/** Thumbnail lives alongside the file, so Caddy serves it from the same /f/ dir. */
export function thumbnailUrl(
  baseUrl: string,
  file: Pick<FileRow, "id" | "thumbnailPath">,
): string | null {
  return file.thumbnailPath ? `${baseUrl}/f/${file.thumbnailPath}` : null;
}

/**
 * Larger poster (≤1920px) for the /v player and /s embed card. Falls back to
 * the small thumbnail for files predating the poster (or whose poster render
 * failed), so callers always get the best available image.
 */
export function posterUrl(
  baseUrl: string,
  file: Pick<FileRow, "id" | "posterPath" | "thumbnailPath">,
): string | null {
  const posterPath = file.posterPath ?? file.thumbnailPath;
  return posterPath ? `${baseUrl}/f/${posterPath}` : null;
}
