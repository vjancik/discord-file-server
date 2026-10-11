import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { createLogger } from "@/lib/logger";
import { sanitizeYtDlpError } from "./errors";
import type { ProbeInfo } from "./selection";

const log = createLogger("bot:ytdlp");

/** yt-dlp progress line, emitted every --progress-delta seconds. */
export type DownloadProgress = {
  downloadedBytes: number;
  totalBytes?: number;
  speedBps?: number;
  etaSeconds?: number;
};

/** Failure with a user-presentable, sanitized message. */
export class YtDlpError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
  }
}
/** The watchdog (or user) killed the process. */
export class DownloadAbortedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export type DownloadRequest = {
  url: string;
  formatIds: string[];
  /** Merge container for split A/V pairs; null = single complete format. */
  mergeFormat: "mp4" | "webm" | null;
  /** Job-private directory; must exist and be empty. */
  dir: string;
  onProgress?: (p: DownloadProgress) => void;
  /**
   * Watchdog, consulted on every progress tick with the byte count: return a
   * reason to kill the download (over remaining quota, scratch cap, …).
   */
  shouldAbort?: (downloadedBytes: number) => string | null;
  /** Immediate cancellation (user pressed Abort). */
  signal?: AbortSignal;
};

const PROGRESS_PREFIX = "EMBEDPROG";
const FILEPATH_SIDECAR = ".final-filepath";
/** SIGTERM → SIGKILL escalation; stays under Docker's 10s stop timeout. */
const KILL_GRACE_MS = 5_000;

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch (err) {
    log.warn({ err, signal }, "failed to signal yt-dlp process group");
    child.kill(signal);
  }
}

/**
 * SIGTERM first: the yt-dlp release is a PyInstaller onefile build whose
 * bootloader forwards it to Python, then deletes its /tmp/_MEI* extraction
 * (a whole Python runtime). SIGKILL skips that cleanup and leaks it, so it is
 * only the fallback for a process group that won't exit.
 */
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalGroup(child, "SIGTERM");
  const timer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
  child.once("close", () => clearTimeout(timer));
}

/** Outcome of a `yt-dlp --update` run. */
export type UpdateResult =
  /** A newer release was installed; a retry may now succeed. */
  | { changed: true; message: string }
  /** Already current, or the update could not be performed. `changed` stays
   *  false so callers never retry a download on the strength of a no-op. */
  | { changed: false; message: string };

/**
 * `--update` prints "yt-dlp is up to date (<version>)" on a no-op and something
 * like "Updating to ..." / "Updated yt-dlp to ..." when it replaces the binary.
 * It exits 0 in both cases, so we key off the text, treating anything that
 * isn't an explicit up-to-date/failure as a real change worth retrying on.
 */
const UP_TO_DATE = /is up to date/i;
const UPDATE_FAILED = /ERROR|Unable to (write|rename)|not writable|Permission/i;

const num = (s: string | undefined): number | undefined => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * Thin process wrapper around the yt-dlp binary. Never re-encodes: no
 * --recode-video, merges are ffmpeg stream copy into --merge-output-format
 * (docs/embed-video.md "envelope changes are fine, full re-encodes aren't").
 */
export class YtDlp {
  /** Live processes, so shutdown can stop them and wait for their cleanup. */
  private readonly running = new Set<{
    stop(reason: string): void;
    closed: Promise<void>;
  }>();
  private stopped = false;

  constructor(private readonly binary = "yt-dlp") {}

  /**
   * Shutdown: refuse new spawns, terminate live ones and wait until they exit.
   * Exiting the bot (PID 1) first would SIGKILL them and leak their /tmp
   * extraction.
   */
  async stopAll(): Promise<void> {
    this.stopped = true;
    for (const proc of this.running) proc.stop("the bot is restarting.");
    await Promise.all([...this.running].map((proc) => proc.closed));
  }

  async probe(url: string): Promise<ProbeInfo> {
    const { stdout, stderr, code } = await this.run(
      ["-J", "--no-playlist", "--no-warnings", "--", url],
      {},
    );
    if (code !== 0) throw new YtDlpError(sanitizeYtDlpError(stderr));
    try {
      return JSON.parse(stdout) as ProbeInfo;
    } catch {
      throw new YtDlpError("yt-dlp returned unparseable metadata.");
    }
  }

  /**
   * Runs `yt-dlp --update` in place. Best-effort: never throws — a failed
   * self-update (offline, read-only binary, GitHub down) must not take down the
   * caller, which either just wants a fresh binary at boot or is already
   * handling a download failure. Returns whether the binary actually changed.
   */
  async update(): Promise<UpdateResult> {
    let result: Awaited<ReturnType<typeof this.run>>;
    try {
      result = await this.run(["--update"], {});
    } catch (err) {
      log.warn({ err }, "yt-dlp --update could not be spawned");
      return { changed: false, message: String(err) };
    }
    const message = (result.stdout + result.stderr).trim();
    const changed =
      result.code === 0 &&
      !UP_TO_DATE.test(message) &&
      !UPDATE_FAILED.test(message);
    if (changed) log.info({ message }, "yt-dlp updated");
    else log.info({ message, code: result.code }, "yt-dlp not updated");
    return { changed, message };
  }

  /**
   * Downloads into `req.dir` and resolves with the final media file path. On a
   * yt-dlp failure (not an abort/cancel) makes one `--update` attempt and, if it
   * actually pulled a newer binary, retries the download once — yt-dlp breaks
   * against site changes constantly and the fix is almost always a fresh
   * release. `dir` is wiped between attempts so the retry starts clean.
   */
  async download(req: DownloadRequest): Promise<{ filePath: string }> {
    try {
      return await this.downloadOnce(req);
    } catch (err) {
      if (err instanceof DownloadAbortedError) throw err;
      if (req.signal?.aborted) throw err;
      const { changed } = await this.update();
      if (!changed) throw err;
      log.info("retrying download after yt-dlp update");
      this.resetDir(req.dir);
      return await this.downloadOnce(req);
    }
  }

  /** Removes everything under `dir` (partials, sidecar) but keeps `dir`. */
  private resetDir(dir: string): void {
    try {
      for (const entry of readdirSync(dir)) {
        rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    } catch (err) {
      log.warn({ err, dir }, "failed to reset job dir before retry");
    }
  }

  private async downloadOnce(req: DownloadRequest): Promise<{
    filePath: string;
  }> {
    const sidecar = path.join(req.dir, FILEPATH_SIDECAR);
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--progress",
      "--progress-delta",
      "2",
      "--progress-template",
      `download:${PROGRESS_PREFIX} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s`,
      "-f",
      req.formatIds.join("+"),
      ...(req.mergeFormat ? ["--merge-output-format", req.mergeFormat] : []),
      "--print-to-file",
      "after_move:filepath",
      sidecar,
      "-o",
      // .NB truncates to N UTF-8 bytes on a character boundary. Budget:
      // 180 title + 2 + 32 id + 1 + ~5 ext + yt-dlp's transient ".fNNN.part"
      // suffixes stays under the 255-byte NAME_MAX per path component.
      path.join(req.dir, "%(title).180B [%(id).32B].%(ext)s"),
      "--",
      req.url,
    ];

    const { stderr, code, aborted } = await this.run(args, {
      onStdoutLine: (line) => {
        if (!line.startsWith(PROGRESS_PREFIX)) return;
        const [downloaded, total, totalEst, speed, eta] = line
          .slice(PROGRESS_PREFIX.length + 1)
          .split(" ");
        const progress: DownloadProgress = {
          downloadedBytes: num(downloaded) ?? 0,
          totalBytes: num(total) ?? num(totalEst),
          speedBps: num(speed),
          etaSeconds: num(eta),
        };
        req.onProgress?.(progress);
        return req.shouldAbort?.(progress.downloadedBytes) ?? undefined;
      },
      signal: req.signal,
    });

    if (aborted) throw new DownloadAbortedError(aborted);
    if (code !== 0) throw new YtDlpError(sanitizeYtDlpError(stderr));

    const filePath = this.finalFilePath(req.dir, sidecar);
    if (!filePath)
      throw new YtDlpError("Download finished but no file was produced.");
    return { filePath };
  }

  /** The sidecar written by --print-to-file, else the largest non-partial file. */
  private finalFilePath(dir: string, sidecar: string): string | null {
    try {
      const fromSidecar = readFileSync(sidecar, "utf8")
        .trim()
        .split("\n")
        .at(-1);
      if (fromSidecar && statSync(fromSidecar).isFile()) return fromSidecar;
    } catch {}
    const files = readdirSync(dir)
      .filter((f) => !f.endsWith(".part") && !f.startsWith("."))
      .map((f) => path.join(dir, f))
      .filter((p) => statSync(p).isFile());
    if (files.length === 0) return null;
    return files.reduce((a, b) =>
      statSync(a).size >= statSync(b).size ? a : b,
    );
  }

  /**
   * Spawns yt-dlp in its own process group so a watchdog stop also takes out
   * ffmpeg children. `onStdoutLine` may return a reason string to abort.
   */
  private run(
    args: string[],
    opts: {
      onStdoutLine?: (line: string) => string | undefined;
      signal?: AbortSignal;
    },
  ): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    aborted?: string;
  }> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new Error("yt-dlp is shutting down"));
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(this.binary, args, {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      let lineBuf = "";
      let aborted: string | undefined;

      const kill = (reason: string) => {
        if (aborted) return;
        aborted = reason;
        terminate(child);
      };

      let settle!: () => void;
      const proc = {
        stop: kill,
        closed: new Promise<void>((r) => {
          settle = r;
        }),
      };
      this.running.add(proc);
      const done = () => {
        this.running.delete(proc);
        settle();
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        lineBuf += chunk.toString();
        let nl = lineBuf.indexOf("\n");
        while (nl >= 0) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (line) {
            const abortReason = opts.onStdoutLine?.(line);
            if (abortReason) kill(abortReason);
          }
          nl = lineBuf.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        // Keep only a tail: enough for error reporting, bounded memory.
        stderr = (stderr + chunk.toString()).slice(-16_384);
      });
      if (opts.signal) {
        const onAbort = () => kill("Cancelled.");
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (err) => {
        done();
        reject(err);
      });
      child.on("close", (code) => {
        done();
        resolve({ stdout, stderr, code: code ?? -1, aborted });
      });
    });
  }
}
