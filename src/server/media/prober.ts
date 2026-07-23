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
  /** Writes a poster/thumbnail JPEG; resolves false when none can be made (e.g. audio). */
  makeThumbnail(
    sourcePath: string,
    destPath: string,
    kind: FileKind,
    info: MediaInfo,
  ): Promise<boolean>;
}

const log = createLogger("prober");

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string }> {
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
      "scale='min(640,iw)':-2",
      destPath,
    );
    const { ok } = await run(args);
    return ok;
  }
}
