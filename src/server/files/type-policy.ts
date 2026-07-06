import { fileTypeFromBuffer } from "file-type";
import type { FileKind } from "@/db/schema";
import { BLOCKED_EXTENSIONS, extensionOf } from "@/lib/blocked-extensions";

export { extensionOf };

/**
 * File type policy (PRD §5): multimedia embeds as a player, other non-executable
 * files embed as a download card, executables are blocked at upload.
 *
 * The pre-create stage (`classifyUpload`) sees only tus metadata — extension and
 * the client-reported MIME, both untrusted. The finalize stage (`sniffExecutable`)
 * re-checks the actual bytes before the file is published.
 */

// Keep in sync with the @media matcher in the Caddyfile (Phase 8).
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  // svg intentionally absent: inline SVG can execute script on our origin,
  // so it is classified "other" and served as a download.
};

const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

// Blocklist + extension helper live in src/lib/blocked-extensions.ts so the
// upload page can reuse them for client-side feedback.

/** file-type sniffed extensions that mean "this is an executable binary". */
const BLOCKED_SNIFFED = new Set([
  "exe",
  "elf",
  "macho",
  "class",
  "apk",
  "msi",
  "dmg",
  "deb",
  "rpm",
]);

export type Classification =
  | { ok: true; kind: FileKind; mimeType: string; fileName: string }
  | { ok: false; reason: string };

/**
 * Pre-create policy check from upload metadata. Media MIME is derived from the
 * extension (never from the client): /f/* serving and Discord embeds key off
 * the extension, so the two must agree.
 */
export function classifyUpload(
  rawFileName: string,
  clientMime?: string,
): Classification {
  const fileName = sanitizeFileName(rawFileName);
  const ext = extensionOf(fileName);

  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `Executable files (.${ext}) are not allowed.` };
  }

  if (VIDEO_MIME[ext])
    return { ok: true, kind: "video", mimeType: VIDEO_MIME[ext], fileName };
  if (IMAGE_MIME[ext])
    return { ok: true, kind: "image", mimeType: IMAGE_MIME[ext], fileName };
  if (AUDIO_MIME[ext])
    return { ok: true, kind: "audio", mimeType: AUDIO_MIME[ext], fileName };

  const mimeType =
    clientMime && /^[\w-]+\/[\w.+-]+$/.test(clientMime)
      ? clientMime
      : "application/octet-stream";
  return { ok: true, kind: "other", mimeType, fileName };
}

/**
 * Finalize-stage check on the actual bytes (first few KB suffice): rejects
 * executables smuggled past the extension check under an innocent name.
 */
export async function sniffExecutable(head: Uint8Array): Promise<boolean> {
  // Shebang scripts (#!/bin/sh …) — text, invisible to file-type.
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return true;
  const sniffed = await fileTypeFromBuffer(head);
  if (!sniffed) return false;
  return BLOCKED_SNIFFED.has(sniffed.ext);
}

/** Safe-for-disk-and-URL filename: strips path tricks, keeps the extension. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  let name = base
    .normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f<>:"|?*%#]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (name.length > 180) {
    const ext = extensionOf(name);
    const keep = ext ? 180 - ext.length - 1 : 180;
    name = ext ? `${name.slice(0, keep)}.${ext}` : name.slice(0, 180);
  }
  return name || "file";
}
