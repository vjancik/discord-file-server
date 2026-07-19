import {
  accessSync,
  constants,
  mkdirSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { createLogger } from "@/lib/logger";
import { formatBytes } from "@/lib/units";
import type { DiscordProfile } from "../identity";
import { type Candidate, type ProbeInfo, planEmbed } from "./selection";
import {
  TusUploadError,
  type TusUploadResult,
  UploadCancelledError,
} from "./tus-client";
import type { EmbedCheck } from "./verify";
import {
  DownloadAbortedError,
  type DownloadProgress,
  type DownloadRequest,
  YtDlpError,
} from "./ytdlp";

const log = createLogger("bot:embed");

/**
 * UI port: the Discord layer renders status edits and invoker-only button
 * dialogs; the orchestrator below stays discord.js-free (docs/embed-video.md).
 */
export type AskOption = {
  id: string;
  label: string;
  style: "primary" | "danger" | "secondary";
};
export interface EmbedUi {
  status(text: string): Promise<void>;
  /** Short button labels; detail belongs in `text`. Resolves id or "timeout". */
  ask(
    text: string,
    options: AskOption[],
    timeoutMs: number,
  ): Promise<string | "timeout">;
  finish(text: string): Promise<void>;
}

export type UploadFn = (opts: {
  filePath: string;
  fileName: string;
  mimeType: string;
  token: () => string;
  onQueued?: (reason: string) => void;
  signal?: AbortSignal;
}) => Promise<TusUploadResult>;

export type EmbedServiceDeps = {
  ytdlp: {
    probe(url: string): Promise<ProbeInfo>;
    download(req: DownloadRequest): Promise<{ filePath: string }>;
  };
  verifier: { verify(filePath: string, limit: number): Promise<EmbedCheck> };
  upload: UploadFn;
  identity: { provisionUser(profile: DiscordProfile): string };
  quota: { quotaFor(userId: string): number; usageFor(userId: string): number };
  mintToken: (userId: string, maxBytes: number) => string;
};

export type EmbedServiceOpts = {
  embedLimit: number;
  maxFileSize?: number;
  scratchDir: string;
  scratchLimit: number;
  dialogTimeoutMs?: number;
  scratchWaitDelayMs?: number;
  scratchWaitMaxMs?: number;
  /** Injectable for tests; defaults to statfs on the scratch dir. */
  freeDiskBytes?: (dir: string) => number;
};

const DIALOG_TIMEOUT_MS = 10 * 60_000;
const SCRATCH_FLOOR_BYTES = 1 << 30; // required headroom when size is unknown

const scrub = (s: string) => s.replace(/[*_`~|\\]/g, "").slice(0, 120);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DownloadAbortedError("Cancelled."));
      },
      { once: true },
    );
  });

function statfsFree(dir: string): number {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

function duSync(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = statSync(p);
      total += st.isDirectory() ? duSync(p) : st.size;
    } catch {}
  }
  return total;
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
};

export class EmbedService {
  /** Single-flight: one download job at a time; others wait in FIFO order. */
  private tail: Promise<void> = Promise.resolve();
  private busy = 0;

  constructor(
    private readonly deps: EmbedServiceDeps,
    private readonly opts: EmbedServiceOpts,
  ) {
    // Fail at boot, not mid-job: a mounted scratch dir created by Docker is
    // root-owned until the operator chowns it (README: host dirs must be
    // writable by uid 1001), and mkdirSync happily no-ops on the mount.
    mkdirSync(opts.scratchDir, { recursive: true });
    try {
      accessSync(opts.scratchDir, constants.W_OK);
    } catch {
      throw new Error(
        `Embed scratch dir ${opts.scratchDir} is not writable by this user — ` +
          `chown the host directory to uid 1001 (see README host mounts).`,
      );
    }
  }

  /** Boot-time sweep of scratch left behind by a crashed previous run. */
  sweepScratch(): void {
    for (const name of readdirSync(this.opts.scratchDir)) {
      log.warn({ name }, "sweeping orphaned embed scratch");
      rmSync(path.join(this.opts.scratchDir, name), {
        recursive: true,
        force: true,
      });
    }
  }

  /** Queues the job; a queued job tells the user it's waiting its turn. */
  enqueue(
    url: string,
    invoker: DiscordProfile,
    ui: EmbedUi,
    signal?: AbortSignal,
  ): Promise<void> {
    const position = this.busy;
    this.busy++;
    if (position > 0)
      void ui.status(`⏳ Queued behind ${position} other download(s)…`);
    const job = this.tail
      .then(() => this.run(url, invoker, ui, signal))
      .catch((err) => {
        log.error({ err, url }, "embed job crashed");
        return ui.finish("Something went wrong running this download.");
      })
      .finally(() => {
        this.busy--;
      });
    this.tail = job;
    return job;
  }

  private async run(
    url: string,
    invoker: DiscordProfile,
    ui: EmbedUi,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return ui.finish("Cancelled.");
    const dialogTimeout = this.opts.dialogTimeoutMs ?? DIALOG_TIMEOUT_MS;
    const userId = this.deps.identity.provisionUser(invoker);

    await ui.status("🔍 Looking up video info…");
    let info: ProbeInfo;
    try {
      info = await this.deps.ytdlp.probe(url);
    } catch (err) {
      if (err instanceof YtDlpError) return ui.finish(err.userMessage);
      throw err;
    }
    const title = scrub(info.title ?? "video");
    const plan = planEmbed(info, this.opts.embedLimit);
    if (plan.kind === "reject") return ui.finish(plan.reason);

    // Per-user remaining quota + optional server per-file cap.
    const remaining = Math.max(
      0,
      this.deps.quota.quotaFor(userId) - this.deps.quota.usageFor(userId),
    );
    const perFileCap = Math.min(remaining, this.opts.maxFileSize ?? Infinity);

    const decision = await this.decide(plan, title, ui, dialogTimeout);
    if (decision === null) return; // decide() already finished the reply
    const { choice, warned } = decision;

    const est =
      choice.estimate.confidence === "unknown" ? null : choice.estimate.bytes;
    if (est !== null && est > perFileCap) {
      return ui.finish(
        `**${title}** is ${choice.label} — more than the **${formatBytes(perFileCap)}** you can upload ` +
          (est > remaining
            ? `(remaining quota; manage your files or free space first).`
            : `(server per-file limit).`),
      );
    }

    if (
      !(await this.waitForScratch(est, choice.mergeFormat !== null, ui, signal))
    )
      return;

    const jobDir = path.join(this.opts.scratchDir, crypto.randomUUID());
    mkdirSync(jobDir, { recursive: true });
    try {
      await this.download(
        { url, title, choice, jobDir, perFileCap, userId, warned },
        ui,
        signal,
      );
    } finally {
      rmSync(jobDir, { recursive: true, force: true });
    }
  }

  /**
   * Pre-download decision dialogue; null = flow already concluded.
   * `warned` records what the user already accepted here: "over-limit" means
   * they explicitly chose a version known to exceed the embed limit (that IS
   * the confirm — no re-asking post-download); "unknown" means they proceeded
   * on a may-exceed warning (the post-download Keep dialogue is the real
   * decision); "none" means nothing was disclosed (silent fits route).
   */
  private async decide(
    plan: Exclude<ReturnType<typeof planEmbed>, { kind: "reject" }>,
    title: string,
    ui: EmbedUi,
    timeoutMs: number,
  ): Promise<{
    choice: Candidate;
    warned: "over-limit" | "unknown" | "none";
  } | null> {
    const limit = formatBytes(this.opts.embedLimit);
    if (plan.kind === "fits") return { choice: plan.best, warned: "none" };

    if (plan.kind === "unknown") {
      const answer = await ui.ask(
        `**${title}** — the file size can't be determined for this source, so it may ` +
          `exceed the ${limit} embed limit (it would still upload and link fine, ` +
          `just not inline-embed). Proceed?`,
        [
          { id: "proceed", label: "Proceed", style: "primary" },
          { id: "cancel", label: "Cancel", style: "secondary" },
        ],
        timeoutMs,
      );
      if (answer !== "proceed") return this.cancelled(ui, answer);
      return { choice: plan.best, warned: "unknown" };
    }

    // "Full quality" only makes sense against a smaller alternative; with a
    // single (or no fitting) option it's just "download anyway".
    const fitLine = plan.fit
      ? ` Best version that embeds: **${plan.fit.label}**.`
      : ` No smaller version fits the embed limit.`;
    const qualifier = plan.fit ? " at full quality" : "";
    const options: AskOption[] = [
      {
        id: "full",
        label: plan.fit ? "Full quality" : "Download anyway",
        style: "primary",
      },
      ...(plan.fit
        ? [{ id: "fit", label: "Fit embed", style: "primary" as const }]
        : []),
      { id: "cancel", label: "Cancel", style: "secondary" },
    ];
    const answer = await ui.ask(
      `**${title}** is **${plan.best.label}**${qualifier} — over the ${limit} ` +
        `embed limit, so it won't inline-embed (the link still works).${fitLine}`,
      options,
      timeoutMs,
    );
    if (answer === "full") return { choice: plan.best, warned: "over-limit" };
    if (answer === "fit" && plan.fit)
      return { choice: plan.fit, warned: "none" };
    return this.cancelled(ui, answer);
  }

  private async cancelled(ui: EmbedUi, answer: string): Promise<null> {
    await ui.finish(
      answer === "timeout" ? "Timed out — cancelled." : "Cancelled.",
    );
    return null;
  }

  /**
   * Scratch admission (docs/embed-video.md): the filesystem is the shared
   * ledger with web-upload staging. Wait (abortable) while the volume or the
   * scratch cap can't hold the estimated bytes plus merge headroom.
   */
  private async waitForScratch(
    estimate: number | null,
    willMerge: boolean,
    ui: EmbedUi,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const freeDisk = this.opts.freeDiskBytes ?? statfsFree;
    // Merging keeps video+audio+output on disk at once — ~2.2x; single-file
    // downloads only need the file plus slack.
    const needed =
      estimate === null
        ? SCRATCH_FLOOR_BYTES
        : Math.ceil(estimate * (willMerge ? 2.2 : 1.1));
    const deadline = Date.now() + (this.opts.scratchWaitMaxMs ?? 10 * 60_000);
    let announced = false;
    for (;;) {
      if (signal?.aborted) {
        await ui.finish("Cancelled.");
        return false;
      }
      const free = Math.min(
        freeDisk(this.opts.scratchDir),
        this.opts.scratchLimit - duSync(this.opts.scratchDir),
      );
      if (free >= needed) return true;
      if (Date.now() >= deadline) {
        await ui.finish(
          "The server doesn't have enough free download space right now — try again later.",
        );
        return false;
      }
      if (!announced) {
        announced = true;
        await ui.status("⏳ Waiting for download space on the server…");
      }
      try {
        await sleep(this.opts.scratchWaitDelayMs ?? 10_000, signal);
      } catch {
        await ui.finish("Cancelled.");
        return false;
      }
    }
  }

  private async download(
    job: {
      url: string;
      title: string;
      choice: Candidate;
      jobDir: string;
      perFileCap: number;
      userId: string;
      warned: "over-limit" | "unknown" | "none";
    },
    ui: EmbedUi,
    signal?: AbortSignal,
  ): Promise<void> {
    const { url, title, choice, jobDir, perFileCap, userId, warned } = job;
    const dialogTimeout = this.opts.dialogTimeoutMs ?? DIALOG_TIMEOUT_MS;
    const cap = Math.min(perFileCap, this.opts.scratchLimit);

    let filePath: string;
    try {
      await ui.status(`⬇️ **${title}** — starting download…`);
      ({ filePath } = await this.deps.ytdlp.download({
        url,
        formatIds: choice.formatIds,
        mergeFormat: choice.mergeFormat,
        dir: jobDir,
        onProgress: (p) => void ui.status(progressLine(title, p)),
        shouldAbort: (bytes) =>
          bytes > cap
            ? `the download exceeded the ${formatBytes(cap)} limit`
            : null,
        signal,
      }));
    } catch (err) {
      if (err instanceof DownloadAbortedError)
        return ui.finish(
          err.reason === "Cancelled."
            ? "🛑 Cancelled — partial download deleted."
            : `🛑 Stopped: ${err.reason} Partial download deleted.`,
        );
      if (err instanceof YtDlpError) return ui.finish(err.userMessage);
      throw err;
    }

    // Phase 4: verify what we actually got, on every route.
    const check = await this.deps.verifier.verify(
      filePath,
      this.opts.embedLimit,
    );
    if (check.sizeBytes > perFileCap) {
      return ui.finish(
        `**${title}** came out **${formatBytes(check.sizeBytes)}** — more than the ` +
          `**${formatBytes(perFileCap)}** you have available, so it was deleted. ` +
          `Free up some space and try again.`,
      );
    }
    // Over-limit is the *expected* outcome when the user already chose a
    // version known to exceed the embed limit — their pre-download click was
    // the confirm; don't re-ask or re-explain. Any other failure (container
    // surprise, or a size surprise on the fits/unknown routes) still gets the
    // Keep/Delete dialogue — the single confirm for that outcome.
    let embedNote = "";
    if (!check.embeddable) {
      const sizeOnlyFailure =
        (check.container === "mp4" || check.container === "webm") &&
        check.sizeBytes > this.opts.embedLimit;
      const expected = warned === "over-limit" && sizeOnlyFailure;
      if (!expected) {
        const answer = await ui.ask(
          `**${title}** downloaded, but ${check.reason} — keep it anyway? ` +
            `The link will still work as a normal file page.`,
          [
            { id: "keep", label: "Keep", style: "primary" },
            { id: "delete", label: "Delete", style: "danger" },
          ],
          dialogTimeout,
        );
        if (answer !== "keep") {
          return ui.finish(
            answer === "timeout" ? "Timed out — discarded." : "🗑️ Discarded.",
          );
        }
        // The note stays only where the reply is the first disclosure to the
        // channel: the silent fits route that came out over. The unknown
        // route already warned publicly before downloading.
        if (warned === "none")
          embedNote = `\n-# Won't inline-embed: ${check.reason}.`;
      }
    }

    await ui.status(`⬆️ **${title}** — uploading to the server…`);
    try {
      const result = await this.deps.upload({
        filePath,
        fileName: path.basename(filePath),
        mimeType:
          MIME_BY_EXT[path.extname(filePath).toLowerCase()] ??
          "application/octet-stream",
        token: () => this.deps.mintToken(userId, check.sizeBytes),
        onQueued: () =>
          void ui.status(`⏳ **${title}** — waiting for staging space…`),
        signal,
      });
      // The short link, not /f/: it's the one that will carry the video
      // title/description card in the metadata iteration (docs/planned.md).
      await ui.finish(`${result.shortUrl}${embedNote}`);
    } catch (err) {
      if (err instanceof UploadCancelledError)
        return ui.finish("🛑 Cancelled — nothing was uploaded.");
      if (err instanceof TusUploadError)
        return ui.finish(`Upload failed: ${err.message}`);
      throw err;
    }
  }
}

function progressLine(title: string, p: DownloadProgress): string {
  const done = formatBytes(p.downloadedBytes);
  const total = p.totalBytes ? ` of ~${formatBytes(p.totalBytes)}` : "";
  const pct = p.totalBytes
    ? ` (${Math.min(100, Math.round((p.downloadedBytes / p.totalBytes) * 100))}%)`
    : "";
  const speed = p.speedBps ? ` · ${formatBytes(p.speedBps)}/s` : "";
  const eta =
    p.etaSeconds !== undefined ? ` · ETA ${formatEta(p.etaSeconds)}` : "";
  return `⬇️ **${title}** — ${done}${total}${pct}${speed}${eta}`;
}

function formatEta(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
