import { statSync } from "node:fs";
import { createLogger } from "@/lib/logger";
import { formatBytes } from "@/lib/units";

const log = createLogger("bot:verify");

export type EmbedCheck = {
  sizeBytes: number;
  container: string;
  embeddable: boolean;
  /** User-presentable explanation when not embeddable. */
  reason?: string;
};

type FfprobeRunner = (filePath: string) => Promise<string | null>;

async function runFfprobe(filePath: string): Promise<string | null> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      filePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return exitCode === 0 ? stdout : null;
}

/**
 * Post-download reality check (docs/embed-video.md phase 4): what did we
 * actually get, and will Discord inline-embed it? Runs on the scratch file
 * before any upload. Embeddable = mp4/webm container within the size limit;
 * codecs are deliberately not policed.
 */
export class EmbedVerifier {
  constructor(private readonly probe: FfprobeRunner = runFfprobe) {}

  async verify(filePath: string, embedLimit: number): Promise<EmbedCheck> {
    const sizeBytes = statSync(filePath).size;
    const container = await this.container(filePath);

    if (container !== "mp4" && container !== "webm")
      return {
        sizeBytes,
        container,
        embeddable: false,
        reason: `the resulting container (${container}) doesn't inline-embed`,
      };
    if (sizeBytes > embedLimit)
      return {
        sizeBytes,
        container,
        embeddable: false,
        reason: `it came out ${formatBytes(sizeBytes)}, over the ${formatBytes(embedLimit)} embed limit`,
      };
    return { sizeBytes, container, embeddable: true };
  }

  private async container(filePath: string): Promise<string> {
    const raw = await this.probe(filePath);
    if (raw === null) return "unreadable";
    try {
      const names: string =
        (JSON.parse(raw) as { format?: { format_name?: string } }).format
          ?.format_name ?? "";
      if (names.split(",").includes("mp4")) return "mp4";
      // ffprobe reports webm and mkv identically ("matroska,webm"); our
      // merge format is what decided the real container — trust the extension.
      if (names.includes("webm") && filePath.endsWith(".webm")) return "webm";
      return names.split(",")[0] || "unknown";
    } catch (err) {
      log.warn({ err, filePath }, "ffprobe output parse failed");
      return "unknown";
    }
  }
}
