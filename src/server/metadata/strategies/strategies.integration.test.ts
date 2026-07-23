import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripAv } from "./av";
import { stripImage } from "./image";
import { stripPdf } from "./pdf";

/**
 * Real-binary integration tests: these run the actual exiftool/ffmpeg/qpdf
 * recipes against generated fixtures and assert the PII is gone. Locally they
 * skip per missing tool; CI installs all three so nothing skips there
 * (.github/workflows/test-and-build.yml).
 */
const hasFfmpeg = !!(Bun.which("ffmpeg") && Bun.which("ffprobe"));
const hasExiftool = !!Bun.which("exiftool");
const hasQpdf = !!Bun.which("qpdf");

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "strip-integration-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed: ${stderr}`);
  return stdout;
}

async function exifTags(file: string): Promise<Record<string, unknown>> {
  const json = await run(["exiftool", "-json", "-n", file]);
  return (JSON.parse(json) as Record<string, unknown>[])[0];
}

async function ffprobeJson(file: string): Promise<{
  format: { duration?: string; tags?: Record<string, string> };
  streams: Array<{ codec_type?: string; tags?: Record<string, string> }>;
}> {
  const out = await run([
    "ffprobe",
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  return JSON.parse(out);
}

describe.skipIf(!hasFfmpeg || !hasExiftool)("stripImage (exiftool)", () => {
  test("drops GPS/artist, keeps orientation and pixels", async () => {
    const src = path.join(tmp, "gps.jpg");
    const dest = path.join(tmp, "gps.clean.jpg");
    await run([
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:size=64x64",
      "-frames:v",
      "1",
      src,
    ]);
    await run([
      "exiftool",
      "-quiet",
      "-GPSLatitude=50.0875",
      "-GPSLatitudeRef=N",
      "-GPSLongitude=14.4214",
      "-GPSLongitudeRef=E",
      "-Artist=John Doe",
      "-Orientation#=6",
      "-overwrite_original",
      src,
    ]);
    // sanity: the fixture is actually dirty
    expect(await exifTags(src)).toMatchObject({ Artist: "John Doe" });

    await stripImage(src, dest);

    const tags = await exifTags(dest);
    for (const key of Object.keys(tags)) {
      expect(key.startsWith("GPS")).toBe(false);
    }
    expect(tags.Artist).toBeUndefined();
    expect(tags.Orientation).toBe(6); // functional tag survives
    // still a decodable 64x64 image
    expect(tags.ImageWidth).toBe(64);
  });
});

describe.skipIf(!hasFfmpeg)("stripAv (ffmpeg)", () => {
  test("mp4: global tags and creation times gone, streams intact", async () => {
    const src = path.join(tmp, "tagged.mp4");
    const dest = path.join(tmp, "tagged.clean.mp4");
    await run([
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=1:size=64x64:rate=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-metadata",
      "title=Secret Title",
      "-metadata",
      "comment=john@example.com",
      "-metadata",
      "location=+50.0875+014.4214/",
      "-metadata",
      "creation_time=2024-06-01T12:00:00Z",
      "-shortest",
      src,
    ]);

    await stripAv(src, dest, "video", "mp4");

    const probe = await ffprobeJson(dest);
    const allTags = JSON.stringify([
      probe.format.tags ?? {},
      ...probe.streams.map((s) => s.tags ?? {}),
    ]).toLowerCase();
    expect(allTags).not.toContain("secret");
    expect(allTags).not.toContain("john");
    expect(allTags).not.toContain("50.0875");
    expect(allTags).not.toContain("2024-06-01");
    // both streams survived the remux, duration preserved
    expect(probe.streams.map((s) => s.codec_type).sort()).toEqual([
      "audio",
      "video",
    ]);
    expect(Number(probe.format.duration)).toBeGreaterThan(0.5);
  });

  test("mp3: ID3 tags and cover art dropped, audio intact", async () => {
    const src = path.join(tmp, "tagged.mp3");
    const dest = path.join(tmp, "tagged.clean.mp3");
    const cover = path.join(tmp, "cover.jpg");
    await run([
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:size=64x64",
      "-frames:v",
      "1",
      cover,
    ]);
    await run([
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-i",
      cover,
      "-map",
      "0:a",
      "-map",
      "1:v",
      "-c:v",
      "copy",
      "-id3v2_version",
      "3",
      "-metadata",
      "artist=John Doe",
      "-metadata",
      "album=Private Album",
      src,
    ]);

    await stripAv(src, dest, "audio", "mp3");

    const probe = await ffprobeJson(dest);
    const allTags = JSON.stringify([
      probe.format.tags ?? {},
      ...probe.streams.map((s) => s.tags ?? {}),
    ]).toLowerCase();
    expect(allTags).not.toContain("john");
    expect(allTags).not.toContain("private");
    expect(probe.streams.map((s) => s.codec_type)).toEqual(["audio"]);
  });
});

describe.skipIf(!hasExiftool || !hasQpdf)("stripPdf (exiftool + qpdf)", () => {
  test("author is gone from the bytes entirely, not just marked deleted", async () => {
    const src = path.join(tmp, "authored.pdf");
    const dest = path.join(tmp, "authored.clean.pdf");
    await Bun.write(src, buildPdfWithInfo("John Doe", "Secret Report"));

    await stripPdf(src, dest);

    const bytes = Buffer.from(await Bun.file(dest).arrayBuffer());
    // the whole point of the qpdf pass: exiftool alone leaves the original
    // Info dict recoverable in the file
    expect(bytes.includes(Buffer.from("John Doe"))).toBe(false);
    expect(bytes.includes(Buffer.from("Secret Report"))).toBe(false);
    // still a valid, openable PDF
    await run(["qpdf", "--check", dest]);
  });

  test("intermediate temp file is cleaned up", async () => {
    const src = path.join(tmp, "authored2.pdf");
    const dest = path.join(tmp, "authored2.clean.pdf");
    await Bun.write(src, buildPdfWithInfo("Jane", "T"));
    await stripPdf(src, dest);
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${dest}.exif.pdf`)).toBe(false);
  });
});

/** Minimal single-page PDF with an Info dictionary, valid xref included. */
function buildPdfWithInfo(author: string, title: string): Uint8Array {
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
    `4 0 obj\n<< /Author (${author}) /Title (${title}) >>\nendobj\n`,
  ];
  let body = header;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefPos = body.length;
  const pad = (n: number) => String(n).padStart(10, "0");
  body += `xref\n0 5\n0000000000 65535 f \n${offsets
    .map((o) => `${pad(o)} 00000 n \n`)
    .join("")}`;
  body += `trailer\n<< /Size 5 /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
