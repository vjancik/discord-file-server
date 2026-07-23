import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscordProfile } from "../identity";
import {
  type AskOption,
  EmbedService,
  type EmbedServiceDeps,
  type EmbedServiceOpts,
} from "./embed.service";
import type { ProbeInfo } from "./selection";
import type { EmbedCheck } from "./verify";
import {
  DownloadAbortedError,
  type DownloadRequest,
  YtDlpError,
} from "./ytdlp";

const MB = 1024 * 1024;
const INVOKER: DiscordProfile = { discordId: "42", username: "vix" };

/** Records the conversation; scripted answers for ask(). */
class FakeUi {
  statuses: string[] = [];
  asks: { text: string; options: AskOption[] }[] = [];
  finished: string | null = null;
  answers: string[] = [];

  async status(text: string): Promise<void> {
    this.statuses.push(text);
  }
  async ask(text: string, options: AskOption[]): Promise<string | "timeout"> {
    this.asks.push({ text, options });
    return this.answers.shift() ?? "timeout";
  }
  async finish(text: string): Promise<void> {
    this.finished = text;
  }
}

const smallInfo = (over: Partial<ProbeInfo> = {}): ProbeInfo => ({
  title: "My *Video*",
  duration: 60,
  formats: [
    {
      format_id: "140",
      ext: "m4a",
      vcodec: "none",
      acodec: "mp4a",
      filesize: 1 * MB,
    },
    {
      format_id: "136",
      ext: "mp4",
      vcodec: "avc1",
      acodec: "none",
      height: 720,
      filesize: 30 * MB,
    },
    {
      format_id: "137",
      ext: "mp4",
      vcodec: "avc1",
      acodec: "none",
      height: 1080,
      filesize: 600 * MB,
    },
  ],
  ...over,
});

let tmp: string;
let deps: EmbedServiceDeps;
let ui: FakeUi;
let downloads: DownloadRequest[];
let uploads: Parameters<EmbedServiceDeps["upload"]>[0][];
let savedSources: Array<{ fileId: string } & Record<string, unknown>>;
let probeInfo: ProbeInfo;
let check: EmbedCheck;
let quota: { quotaFor: number; usageFor: number };

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "embed-svc-test-"));
  ui = new FakeUi();
  downloads = [];
  uploads = [];
  savedSources = [];
  probeInfo = smallInfo();
  check = { sizeBytes: 31 * MB, container: "mp4", embeddable: true };
  quota = { quotaFor: 1000 * MB, usageFor: 0 };
  deps = {
    ytdlp: {
      probe: async () => probeInfo,
      download: async (req) => {
        downloads.push(req);
        const filePath = path.join(req.dir, "My Video [x].mp4");
        writeFileSync(filePath, "bytes");
        return { filePath };
      },
    },
    verifier: { verify: async () => check },
    upload: async (opts) => {
      uploads.push(opts);
      return {
        fileId: "f1",
        fileName: opts.fileName,
        kind: "video",
        shortUrl: "https://files.test/s/a",
        canonicalUrl: "https://files.test/f/f1/x.mp4",
      };
    },
    sources: {
      save: (fileId, input) => savedSources.push({ fileId, ...input }),
    },
    identity: { provisionUser: () => "user-1" },
    quota: {
      quotaFor: () => quota.quotaFor,
      usageFor: () => quota.usageFor,
    },
    mintToken: (userId, maxBytes) => `tok:${userId}:${maxBytes}`,
  };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const service = (over: Partial<EmbedServiceOpts> = {}) =>
  new EmbedService(deps, {
    embedLimit: 500 * MB,
    scratchDir: path.join(tmp, "scratch"),
    scratchLimit: 10_000 * MB,
    dialogTimeoutMs: 50,
    scratchWaitDelayMs: 5,
    scratchWaitMaxMs: 40,
    freeDiskBytes: () => 100_000 * MB,
    ...over,
  });

describe("EmbedService flow", () => {
  test("choose dialogue: 'fit' downloads the fitting rung and finishes with the link", async () => {
    ui.answers = ["fit"];
    await service().enqueue("https://x.test/v", INVOKER, ui);

    expect(ui.asks).toHaveLength(1);
    expect(ui.asks[0].text).toContain("1080p");
    expect(ui.asks[0].options.map((o) => o.label)).toEqual([
      "Full quality",
      "Fit embed",
      "Cancel",
    ]);
    expect(downloads[0].formatIds).toEqual(["136", "140"]);
    expect(uploads[0].token()).toBe(`tok:user-1:${31 * MB}`);
    expect(ui.finished).toBe("https://files.test/s/a");
    // markdown scrubbed from the title
    expect(ui.asks[0].text).not.toContain("*Video*");
  });

  test("successful upload saves the raw probe metadata for the watch page", async () => {
    probeInfo = smallInfo({
      description: "  A classic.\n\nSubscribe!  ",
      webpage_url: "https://x.test/watch?v=1",
      view_count: 1_299_168,
      timestamp: 1_779_321_600, // 2026-05-21T00:00:00Z
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(savedSources).toEqual([
      {
        fileId: "f1",
        title: "My *Video*", // raw title, not the markdown-scrubbed one
        description: "A classic.\n\nSubscribe!",
        sourceUrl: "https://x.test/watch?v=1",
        viewCount: 1_299_168,
        uploadedAt: new Date("2026-05-21T00:00:00Z"),
      },
    ]);
    expect(ui.finished).toContain("/s/a");
  });

  test("passes the best source thumbnail url to the upload", async () => {
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
      thumbnails: [
        { url: "https://cdn.test/low.jpg", width: 320, preference: -10 },
        { url: "https://cdn.test/best.jpg", width: 640, preference: 0 },
      ],
    });
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(uploads[0].sourceThumbnailUrl).toBe("https://cdn.test/best.jpg");
  });

  test("no source thumbnail leaves the url undefined", async () => {
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(uploads[0].sourceThumbnailUrl).toBeUndefined();
  });

  test("missing optional probe fields fall back to nulls and the input url", async () => {
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(savedSources[0]).toMatchObject({
      description: null,
      sourceUrl: "https://x.test/v",
      viewCount: null,
      uploadedAt: null,
    });
  });

  test("upload_date YYYYMMDD is used when no exact timestamp exists", async () => {
    probeInfo = smallInfo({
      upload_date: "20260517",
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(savedSources[0].uploadedAt).toEqual(
      new Date("2026-05-17T00:00:00Z"),
    );
  });

  test("a failed metadata save still delivers the link", async () => {
    deps.sources.save = () => {
      throw new Error("db locked");
    };
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(ui.finished).toContain("/s/a");
  });

  test("cancelled or failed jobs save no metadata", async () => {
    ui.answers = []; // choose dialogue times out
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(savedSources).toHaveLength(0);
  });

  test("fits: no dialogue, straight to download", async () => {
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(ui.asks).toHaveLength(0);
    expect(ui.finished).toContain("/s/a");
  });

  test("dialogue timeout cancels without downloading", async () => {
    ui.answers = []; // ask() returns "timeout"
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(ui.finished).toBe("Timed out — cancelled.");
    expect(downloads).toHaveLength(0);
  });

  test("probe failure surfaces the sanitized message", async () => {
    deps.ytdlp.probe = async () => {
      throw new YtDlpError("That site isn't supported by yt-dlp.");
    };
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(ui.finished).toBe("That site isn't supported by yt-dlp.");
  });

  test("known size over remaining quota stops before downloading", async () => {
    quota = { quotaFor: 100 * MB, usageFor: 90 * MB };
    ui.answers = ["fit"]; // 720p ≈ 31 MB > 10 MB remaining
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(downloads).toHaveLength(0);
    expect(ui.finished).toContain("remaining quota");
  });

  test("watchdog reason ends the job with partials deleted", async () => {
    deps.ytdlp.download = async () => {
      throw new DownloadAbortedError("the download exceeded the 100 MB limit");
    };
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(ui.finished).toContain("Partial download deleted");
  });

  test("actual size over quota after best-effort download is discarded", async () => {
    probeInfo = {
      title: "mystery",
      formats: [
        {
          format_id: "hls-1",
          ext: "mp4",
          vcodec: "avc1",
          acodec: "mp4a",
          height: 720,
        },
      ],
    };
    ui.answers = ["proceed"];
    quota = { quotaFor: 100 * MB, usageFor: 80 * MB };
    check = { sizeBytes: 50 * MB, container: "mp4", embeddable: true };
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(uploads).toHaveLength(0);
    expect(ui.finished).toContain("was deleted");
  });

  test("full-quality choice already confirmed over-limit: no re-ask, no note", async () => {
    ui.answers = ["full"];
    check = {
      sizeBytes: 600 * MB,
      container: "mp4",
      embeddable: false,
      reason: "it came out 600 MB, over the 500 MB embed limit",
    };
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(ui.asks).toHaveLength(1); // only the pre-download choice
    expect(uploads).toHaveLength(1);
    expect(ui.finished).toBe("https://files.test/s/a");
  });

  test("unknown-size route re-confirms when it comes out over the limit", async () => {
    probeInfo = {
      title: "mystery",
      formats: [
        {
          format_id: "hls-1",
          ext: "mp4",
          vcodec: "avc1",
          acodec: "mp4a",
          height: 720,
        },
      ],
    };
    ui.answers = ["proceed", "keep"];
    check = {
      sizeBytes: 600 * MB,
      container: "mp4",
      embeddable: false,
      reason: "it came out 600 MB, over the 500 MB embed limit",
    };
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(ui.asks).toHaveLength(2); // may-exceed warning, then Keep/Delete
    expect(uploads).toHaveLength(1);
    // the channel was already warned pre-download — no repeated note
    expect(ui.finished).toBe("https://files.test/s/a");
  });

  test("container surprise after a full-quality confirm still asks", async () => {
    ui.answers = ["full", "keep"];
    check = {
      sizeBytes: 600 * MB,
      container: "mkv",
      embeddable: false,
      reason: "the resulting container (mkv) doesn't inline-embed",
    };
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(ui.asks).toHaveLength(2); // size was accepted, container wasn't
    expect(uploads).toHaveLength(1);
  });

  test("mishap route (fits estimate came out over) keeps the embed note", async () => {
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    ui.answers = ["keep"]; // only one confirm: the Keep dialogue itself
    check = {
      sizeBytes: 607 * MB,
      container: "mp4",
      embeddable: false,
      reason: "it came out 607 MB, over the 500 MB embed limit",
    };
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(uploads).toHaveLength(1);
    expect(ui.finished).toContain("/s/a");
    expect(ui.finished).toContain("Won't inline-embed");
  });

  test("not-embeddable + Delete discards without uploading", async () => {
    // fits route whose estimate undershot — the Keep/Delete ask is the only
    // dialogue, and Delete discards.
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    ui.answers = ["delete"];
    check = {
      sizeBytes: 600 * MB,
      container: "mp4",
      embeddable: false,
      reason: "r",
    };
    await service().enqueue("https://x.test/v", INVOKER, ui);
    expect(uploads).toHaveLength(0);
    expect(ui.finished).toBe("🗑️ Discarded.");
  });

  test("scratch space wait gives up with a friendly message", async () => {
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    await service({ freeDiskBytes: () => 1 * MB }).enqueue(
      "https://x.test/v",
      INVOKER,
      ui,
    );
    expect(downloads).toHaveLength(0);
    expect(ui.statuses.at(-1)).toContain("Waiting for download space");
    expect(ui.finished).toContain("try again later");
  });

  test("scratch dir is cleaned up after success", async () => {
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    const svc = service();
    await svc.enqueue("https://x.test/v", INVOKER, ui);
    expect(readdirSync(path.join(tmp, "scratch"))).toHaveLength(0);
  });

  test("second job queues behind the first", async () => {
    probeInfo = smallInfo({
      formats: probeInfo.formats?.filter((f) => f.format_id !== "137"),
    });
    const order: string[] = [];
    deps.ytdlp.download = async (req) => {
      order.push(req.url);
      await new Promise((r) => setTimeout(r, 30));
      const filePath = path.join(req.dir, "a.mp4");
      writeFileSync(filePath, "x");
      return { filePath };
    };
    const svc = service();
    const ui2 = new FakeUi();
    const first = svc.enqueue("https://x.test/1", INVOKER, ui);
    const second = svc.enqueue("https://x.test/2", INVOKER, ui2);
    expect(ui2.statuses[0]).toContain("Queued behind 1");
    await Promise.all([first, second]);
    expect(order).toEqual(["https://x.test/1", "https://x.test/2"]);
    expect(ui.finished).toContain("/s/a");
    expect(ui2.finished).toContain("/s/a");
  });

  test("sweepScratch removes orphaned job dirs at boot", () => {
    const svc = service();
    const orphan = path.join(tmp, "scratch", "orphan-job");
    writeFileSync(path.join(tmp, "scratch", "stray.part"), "x");
    rmSync(orphan, { recursive: true, force: true });
    svc.sweepScratch();
    expect(existsSync(path.join(tmp, "scratch", "stray.part"))).toBe(false);
  });
});
