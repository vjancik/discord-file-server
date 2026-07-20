import { describe, expect, test } from "bun:test";
import {
  classifyUpload,
  sanitizeFileName,
  sniffExecutable,
} from "./type-policy";

describe("classifyUpload", () => {
  test("classifies media kinds with canonical MIME from the extension", () => {
    expect(classifyUpload("clip.mp4")).toEqual({
      ok: true,
      kind: "video",
      mimeType: "video/mp4",
      fileName: "clip.mp4",
    });
    expect(classifyUpload("photo.JPG")).toMatchObject({
      kind: "image",
      mimeType: "image/jpeg",
    });
    expect(classifyUpload("song.flac")).toMatchObject({
      kind: "audio",
      mimeType: "audio/flac",
    });
  });

  test("ignores the client-reported MIME for media types", () => {
    const result = classifyUpload("clip.mp4", "application/octet-stream");
    expect(result).toMatchObject({
      ok: true,
      kind: "video",
      mimeType: "video/mp4",
    });
  });

  test("non-media files keep a sane client MIME, else octet-stream", () => {
    expect(classifyUpload("archive.zip", "application/zip")).toMatchObject({
      kind: "other",
      mimeType: "application/zip",
    });
    expect(classifyUpload("archive.zip", "not a mime")).toMatchObject({
      mimeType: "application/octet-stream",
    });
    expect(classifyUpload("README")).toMatchObject({ kind: "other" });
  });

  test("blocks executables by extension, case-insensitively", () => {
    for (const name of [
      "setup.exe",
      "SETUP.EXE",
      "script.sh",
      "installer.msi",
      "app.apk",
    ]) {
      const result = classifyUpload(name);
      expect(result.ok).toBe(false);
    }
  });

  test("svg is classified as non-media (scriptable on our origin)", () => {
    expect(classifyUpload("logo.svg", "image/svg+xml")).toMatchObject({
      kind: "other",
    });
  });
});

describe("sniffExecutable", () => {
  test("detects Windows PE (MZ)", async () => {
    const mz = new Uint8Array([
      0x4d,
      0x5a,
      0x90,
      0x00,
      ...new Array(60).fill(0),
    ]);
    expect(await sniffExecutable(mz)).toBe(true);
  });

  test("detects ELF", async () => {
    const elf = new Uint8Array([
      0x7f,
      0x45,
      0x4c,
      0x46,
      2,
      1,
      1,
      0,
      ...new Array(60).fill(0),
    ]);
    expect(await sniffExecutable(elf)).toBe(true);
  });

  test("detects shebang scripts", async () => {
    expect(
      await sniffExecutable(new TextEncoder().encode("#!/bin/sh\nrm -rf /")),
    ).toBe(true);
  });

  test("passes ordinary media bytes", async () => {
    // Minimal PNG signature
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
    ]);
    expect(await sniffExecutable(png)).toBe(false);
    expect(
      await sniffExecutable(new TextEncoder().encode("hello plain text")),
    ).toBe(false);
  });
});

describe("sanitizeFileName", () => {
  test("strips directory components and path tricks", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\evil.mp4")).toBe("evil.mp4");
  });

  test("replaces url/fs-hostile characters but keeps readable names", () => {
    expect(sanitizeFileName('we<ird>:"file"?.mp4')).toBe("we_ird___file__.mp4");
    expect(sanitizeFileName("My Vacation Video.mp4")).toBe(
      "My Vacation Video.mp4",
    );
  });

  test("caps length while preserving the extension", () => {
    const long = `${"a".repeat(300)}.mp4`;
    const out = sanitizeFileName(long);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
    expect(out.endsWith(".mp4")).toBe(true);
  });

  test("caps multibyte names by UTF-8 bytes, not characters", () => {
    // 200 CJK chars = 600 UTF-8 bytes: over NAME_MAX (255) despite being
    // well under the old 180-character cap.
    const long = `${"日".repeat(200)}.mp4`;
    const out = sanitizeFileName(long);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
    expect(out.endsWith(".mp4")).toBe(true);
    expect(out).toMatch(/^日+\.mp4$/); // no split code points
  });

  test("never returns an empty name", () => {
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("...")).toBe("file");
  });
});
