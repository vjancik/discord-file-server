import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DownloadAbortedError,
  type DownloadProgress,
  YtDlp,
  YtDlpError,
} from "./ytdlp";

let tmp: string;
let jobDir: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "ytdlp-test-"));
  jobDir = path.join(tmp, "job");
  mkdirSync(jobDir);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * Fake yt-dlp: a bash script handed the real argv. It resolves the sidecar
 * path (arg after "after_move:filepath") and output dir (dirname of the arg
 * after -o) the way the real binary would.
 */
function fakeYtDlp(body: string): string {
  const bin = path.join(tmp, "yt-dlp-fake");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
SIDECAR=""; OUTDIR=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "after_move:filepath" ]; then SIDECAR="$arg"; fi
  if [ "$prev" = "-o" ]; then OUTDIR="$(dirname "$arg")"; fi
  prev="$arg"
done
${body}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const downloadReq = (over = {}) => ({
  url: "https://example.test/v",
  formatIds: ["137", "140"],
  mergeFormat: "mp4" as const,
  dir: jobDir,
  ...over,
});

describe("YtDlp.download", () => {
  test("reports parsed progress and resolves the final file via sidecar", async () => {
    const bin = fakeYtDlp(`
echo "EMBEDPROG 1000 5000 NA 250.5 16"
echo "EMBEDPROG 5000 5000 NA NA NA"
echo "clip [abc].mp4 content" > "$OUTDIR/clip [abc].mp4"
echo "$OUTDIR/clip [abc].mp4" > "$SIDECAR"
`);
    const seen: DownloadProgress[] = [];
    const { filePath } = await new YtDlp(bin).download(
      downloadReq({ onProgress: (p: DownloadProgress) => seen.push(p) }),
    );

    expect(filePath).toBe(path.join(jobDir, "clip [abc].mp4"));
    expect(seen[0]).toEqual({
      downloadedBytes: 1000,
      totalBytes: 5000,
      speedBps: 250.5,
      etaSeconds: 16,
    });
    expect(seen[1]).toEqual({
      downloadedBytes: 5000,
      totalBytes: 5000,
      speedBps: undefined,
      etaSeconds: undefined,
    });
  });

  test("falls back to the largest non-partial file when the sidecar is missing", async () => {
    const bin = fakeYtDlp(`
echo "small" > "$OUTDIR/a.mp4"
echo "biggest file wins" > "$OUTDIR/b.mp4"
echo "partial" > "$OUTDIR/c.mp4.part"
`);
    const { filePath } = await new YtDlp(bin).download(downloadReq());
    expect(filePath).toBe(path.join(jobDir, "b.mp4"));
  });

  test("watchdog kills the process group and raises DownloadAbortedError", async () => {
    const bin = fakeYtDlp(`
echo "EMBEDPROG 900000 NA NA NA NA"
sleep 30
echo "never" > "$OUTDIR/never.mp4"
`);
    const start = Date.now();
    await expect(
      new YtDlp(bin).download(
        downloadReq({
          shouldAbort: (bytes: number) =>
            bytes > 500_000 ? "Exceeded remaining quota." : null,
        }),
      ),
    ).rejects.toThrow(DownloadAbortedError);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test("an AbortSignal cancels immediately", async () => {
    const bin = fakeYtDlp(`sleep 30`);
    const controller = new AbortController();
    const pending = new YtDlp(bin).download(
      downloadReq({ signal: controller.signal }),
    );
    controller.abort();
    await expect(pending).rejects.toThrow(DownloadAbortedError);
  });

  test("nonzero exit surfaces a sanitized YtDlpError", async () => {
    const bin = fakeYtDlp(`
echo "ERROR: [generic] https://example.test/v : boom" >&2
exit 1
`);
    await expect(new YtDlp(bin).download(downloadReq())).rejects.toThrow(
      YtDlpError,
    );
    try {
      await new YtDlp(bin).download(downloadReq());
    } catch (err) {
      expect((err as YtDlpError).userMessage).toContain(
        "<https://example.test/v>",
      );
    }
  });
});

describe("YtDlp.probe", () => {
  test("parses -J output", async () => {
    const bin = fakeYtDlp(`echo '{"title":"t","duration":10,"formats":[]}'`);
    const info = await new YtDlp(bin).probe("https://example.test/v");
    expect(info.title).toBe("t");
  });

  test("probe failure is sanitized", async () => {
    const bin = fakeYtDlp(
      `echo "ERROR: Unsupported URL: https://x" >&2; exit 1`,
    );
    await expect(new YtDlp(bin).probe("https://x")).rejects.toThrow(
      "That site isn't supported by yt-dlp.",
    );
  });
});
