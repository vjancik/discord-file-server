import type { FileKind } from "@/db/schema";
import { createLogger } from "@/lib/logger";

export interface MediaInfo {
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/**
 * Port for media metadata + thumbnail generation, so the finalize service is
 * testable without ffmpeg installed.
 */
export interface MediaProber {
  probe(filePath: string): Promise<MediaInfo>;
  /**
   * Writes a poster/thumbnail JPEG downscaled to at most `maxWidth` px (never
   * upscaled past the source); resolves false when none can be made (e.g.
   * audio). Called once per size the caller wants (small thumb + large poster).
   */
  makeThumbnail(
    sourcePath: string,
    destPath: string,
    kind: FileKind,
    info: MediaInfo,
    maxWidth: number,
  ): Promise<boolean>;
  /**
   * Fetches a remote poster (e.g. a social source's own thumbnail) and writes
   * it as a normalized JPEG at `destPath`, downscaled to at most `maxWidth` px.
   * Resolves false on any failure (unreachable, oversized, undecodable) so the
   * caller can fall back to a frame-grab. Safe against a hostile URL — never
   * throws.
   */
  thumbnailFromUrl(
    url: string,
    destPath: string,
    maxWidth: number,
  ): Promise<boolean>;
}

const log = createLogger("prober");

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0)
      log.warn(
        { cmd: cmd[0], exitCode, stderr: stderr.slice(0, 500) },
        "command failed",
      );
    return { ok: exitCode === 0, stdout };
  } catch (err) {
    // A missing binary (ENOENT) degrades like a failed run — metadata-less
    // publish instead of a crashed finalize.
    log.warn({ cmd: cmd[0], err }, "command unavailable");
    return { ok: false, stdout: "" };
  }
}

/** Real adapter shelling out to ffprobe/ffmpeg (present in the Docker image). */
export class FfmpegProber implements MediaProber {
  async probe(filePath: string): Promise<MediaInfo> {
    const { ok, stdout } = await run([
      "ffprobe",
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);
    if (!ok) return {};
    try {
      const data = JSON.parse(stdout) as {
        format?: { duration?: string };
        streams?: Array<{
          codec_type?: string;
          width?: number;
          height?: number;
          duration?: string;
        }>;
      };
      const video = data.streams?.find((s) => s.codec_type === "video");
      const duration = Number(data.format?.duration ?? video?.duration);
      return {
        width: video?.width,
        height: video?.height,
        durationSeconds: Number.isFinite(duration)
          ? Math.round(duration)
          : undefined,
      };
    } catch (err) {
      log.warn({ err, filePath }, "ffprobe output parse failed");
      return {};
    }
  }

  async makeThumbnail(
    sourcePath: string,
    destPath: string,
    kind: FileKind,
    info: MediaInfo,
    maxWidth: number,
  ): Promise<boolean> {
    if (kind !== "video" && kind !== "image") return false;
    const args = ["ffmpeg", "-v", "error", "-y"];
    if (kind === "video") {
      // Grab a frame 10% in (max 5 s) so we skip black intro frames.
      const seek = Math.min(5, (info.durationSeconds ?? 0) * 0.1);
      args.push("-ss", seek.toFixed(2));
    }
    args.push(
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-vf",
      thumbScale(maxWidth),
      destPath,
    );
    const { ok } = await run(args);
    return ok;
  }

  async thumbnailFromUrl(
    url: string,
    destPath: string,
    maxWidth: number,
  ): Promise<boolean> {
    const bytes = await fetchPoster(url);
    if (!bytes) return false;
    // Decode from stdin and normalize to a downscaled JPEG so the poster/thumb
    // are shape-consistent with the ffmpeg frame-grab. A non-image (HTML error
    // page, truncated bytes) makes ffmpeg exit non-zero, which run() reports as
    // ok:false — the frame-grab fallback then applies.
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-v",
        "error",
        "-y",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-vf",
        thumbScale(maxWidth),
        destPath,
      ],
      { stdin: bytes, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        log.warn(
          { url, exitCode, stderr: stderr.slice(0, 500) },
          "thumbnail-from-url ffmpeg failed",
        );
        return false;
      }
      return true;
    } catch (err) {
      log.warn({ url, err }, "thumbnail-from-url unavailable");
      return false;
    }
  }
}

/**
 * ffmpeg scale filter: cap width at `maxWidth`, never upscale (min with input
 * width), keep aspect with an even height (-2). Shared by frame-grabs and
 * source posters so every derived image matches shape.
 */
const thumbScale = (maxWidth: number) => `scale='min(${maxWidth},iw)':-2`;

/** Reject a poster larger than this before decoding; a thumbnail is small. */
const POSTER_MAX_BYTES = 16 * 1024 * 1024;
/** Give up on a slow poster host rather than stall finalize. */
const POSTER_TIMEOUT_MS = 10_000;

/**
 * Fetches a remote poster into memory with hostile-URL guards: https-only (no
 * file://, no plaintext), a hard byte cap read incrementally, and a timeout.
 * Returns the bytes, or null on any failure. Never throws.
 */
async function fetchPoster(url: string): Promise<Uint8Array | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // https only: blocks file://, and plaintext that could be redirected/MITM'd.
  if (parsed.protocol !== "https:") {
    log.warn({ url }, "poster url rejected: not https");
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POSTER_TIMEOUT_MS);
  try {
    const res = await fetch(parsed, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "image/*" },
    });
    if (!res.ok || !res.body) {
      log.warn({ url, status: res.status }, "poster fetch failed");
      return null;
    }
    // Read incrementally so a lying/absent Content-Length can't blow past the
    // cap — abort as soon as the accumulated size crosses it.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > POSTER_MAX_BYTES) {
        controller.abort();
        log.warn({ url, total }, "poster exceeded size cap");
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    log.warn({ url, err }, "poster fetch errored");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
