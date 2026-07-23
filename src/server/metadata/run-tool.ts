import { createLogger } from "@/lib/logger";
import { MetadataStripError } from "./errors";

const log = createLogger("metadata-strip");

/**
 * Runs an external cleaning tool, throwing MetadataStripError on any failure —
 * including a missing binary (unlike the prober, which degrades: a metadata
 * strip that silently doesn't happen is a privacy bug, not a nice-to-have).
 */
export async function runTool(
  cmd: string[],
  opts: { okCodes?: number[] } = {},
): Promise<void> {
  const okCodes = opts.okCodes ?? [0];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  } catch (err) {
    log.error({ cmd: cmd[0], err }, "strip tool unavailable");
    throw new MetadataStripError(
      `${cmd[0]} is not available on the server — metadata cleaning is misconfigured.`,
    );
  }
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (!okCodes.includes(exitCode)) {
    log.warn(
      { cmd: cmd[0], exitCode, stderr: stderr.slice(0, 500) },
      "strip tool failed",
    );
    throw new MetadataStripError(
      `${cmd[0]} could not process the file (it may be corrupt or password-protected).`,
    );
  }
}
