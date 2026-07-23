import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
function fakeYtDlp(body: string, updateBody = ""): string {
  const bin = path.join(tmp, "yt-dlp-fake");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
SIDECAR=""; OUTDIR=""
prev=""
for arg in "$@"; do
  if [ "$arg" = "--update" ]; then
    ${updateBody || 'echo "yt-dlp is up to date (2026.07.04)"'}
    exit 0
  fi
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

describe("YtDlp.download retry-on-update", () => {
  test("retries once after --update reports a real change", async () => {
    // First download fails; --update touches a marker in the (fixed) job dir;
    // the retry sees the marker and succeeds. The retry also clears the dir
    // first, so the marker lives outside jobDir.
    const marker = path.join(tmp, "updated");
    const bin = fakeYtDlp(
      `
if [ -f "${marker}" ]; then
  echo "content" > "$OUTDIR/clip [abc].mp4"
  echo "$OUTDIR/clip [abc].mp4" > "$SIDECAR"
  exit 0
fi
echo "ERROR: [generic] Unable to extract data; please report this issue" >&2
exit 1
`,
      `touch "${marker}"; echo "Updating to 2026.09.01"`,
    );
    const { filePath } = await new YtDlp(bin).download(downloadReq());
    expect(filePath).toBe(path.join(jobDir, "clip [abc].mp4"));
  });

  test("does not retry when --update reports up to date", async () => {
    let attempts = 0;
    const counter = path.join(tmp, "attempts");
    const bin = fakeYtDlp(
      `
echo x >> "${counter}"
echo "ERROR: [generic] Unable to extract data" >&2
exit 1
`,
      `echo "yt-dlp is up to date (2026.07.04)"`,
    );
    await expect(new YtDlp(bin).download(downloadReq())).rejects.toThrow(
      YtDlpError,
    );
    attempts = readFileSync(counter, "utf8").trim().split("\n").length;
    expect(attempts).toBe(1);
  });

  test("does not update/retry when the download was aborted by the watchdog", async () => {
    const marker = path.join(tmp, "updated-called");
    const bin = fakeYtDlp(
      `
echo "EMBEDPROG 900000 NA NA NA NA"
sleep 30
`,
      `touch "${marker}"; echo "Updating"`,
    );
    await expect(
      new YtDlp(bin).download(
        downloadReq({
          shouldAbort: (bytes: number) =>
            bytes > 500_000 ? "Exceeded remaining quota." : null,
        }),
      ),
    ).rejects.toThrow(DownloadAbortedError);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("YtDlp.update", () => {
  test("reports changed:false when already up to date", async () => {
    const bin = fakeYtDlp("", `echo "yt-dlp is up to date (2026.07.04)"`);
    const res = await new YtDlp(bin).update();
    expect(res.changed).toBe(false);
  });

  test("reports changed:true when a newer release is installed", async () => {
    const bin = fakeYtDlp("", `echo "Updating to yt-dlp version 2026.09.01"`);
    const res = await new YtDlp(bin).update();
    expect(res.changed).toBe(true);
  });

  test("reports changed:false when the update errors", async () => {
    const bin = fakeYtDlp("", `echo "ERROR: unable to write" >&2`);
    const res = await new YtDlp(bin).update();
    expect(res.changed).toBe(false);
  });

  test("never throws when the binary cannot be spawned", async () => {
    const res = await new YtDlp(path.join(tmp, "does-not-exist")).update();
    expect(res.changed).toBe(false);
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
