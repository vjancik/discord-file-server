import { stat } from "node:fs/promises";
import { getContainer } from "@/server/container";

/**
 * Dev/test fallback for canonical file URLs. In production Caddy serves /f/*
 * straight from disk (with full Range/ETag support) and this handler is never
 * reached; it exists so local dev and e2e tests work without Caddy. Range
 * support here is single-range only — enough for <video> scrubbing in dev.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ fileId: string; fileName: string }> },
) {
  const { fileId, fileName } = await ctx.params;
  const { fileRepo, storage } = getContainer();
  const requestedName = decodeURIComponent(fileName);

  const file = fileRepo.findLiveById(fileId);
  if (!file) return new Response("Not found", { status: 404 });

  // Thumbnail lives in the same directory and has no DB row of its own.
  const isThumbnail = file.thumbnailPath && requestedName === "thumb.jpg";
  if (!isThumbnail && requestedName !== file.fileName) {
    return new Response("Not found", { status: 404 });
  }

  const diskPath = storage.pathFor(
    fileId,
    isThumbnail ? "thumb.jpg" : file.fileName,
  );
  let size: number;
  try {
    size = (await stat(diskPath)).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers({
    "Content-Type": isThumbnail ? "image/jpeg" : file.mimeType,
    "Accept-Ranges": "bytes",
    "X-Robots-Tag": "noindex",
    "Cache-Control": "public, max-age=3600",
  });
  // Media must never be served as an attachment (kills Discord embeds);
  // non-media is always a direct download (PRD §4).
  if (!isThumbnail && file.kind === "other") {
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
  }

  const range = req.headers.get("range");
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (match && (match[1] || match[2])) {
    const start = match[1]
      ? Number(match[1])
      : Math.max(0, size - Number(match[2]));
    const end =
      match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(
      Bun.file(diskPath)
        .slice(start, end + 1)
        .stream(),
      {
        status: 206,
        headers,
      },
    );
  }

  headers.set("Content-Length", String(size));
  return new Response(Bun.file(diskPath).stream(), { status: 200, headers });
}
