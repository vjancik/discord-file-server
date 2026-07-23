import { describe, expect, test } from "bun:test";
import {
  looksLikeText,
  shouldSniffForText,
  stripSupportFor,
  summarizeStripWarnings,
} from "./metadata-support";

describe("stripSupportFor", () => {
  test.each([
    ["photo.JPG", "image"],
    ["pic.heic", "image"],
    ["anim.gif", "image"],
    ["clip.mp4", "av"],
    ["clip.mkv", "av"],
    ["song.mp3", "av"],
    ["voice.opus", "av"],
    ["report.pdf", "pdf"],
    ["doc.docx", "office"],
    ["sheet.ods", "office"],
  ] as const)("%s → full via %s", (name, strategy) => {
    expect(stripSupportFor(name)).toEqual({
      level: "full",
      strategy,
      toggle: strategy === "image" || strategy === "av" ? "media" : "documents",
    });
  });

  test("zip is container-only", () => {
    expect(stripSupportFor("backup.zip")).toEqual({
      level: "container",
      strategy: "zip",
      toggle: "documents",
    });
  });

  test.each(["dump.tar", "dump.tar.gz", "dump.tgz", "x.7z", "x.rar"])(
    "%s → unsupported archive with warning",
    (name) => {
      expect(stripSupportFor(name)).toEqual({
        level: "none",
        archive: true,
        warn: true,
      });
    },
  );

  test("unknown binary formats warn; plain text does not", () => {
    expect(stripSupportFor("old.doc")).toEqual({
      level: "none",
      archive: false,
      warn: true,
    });
    expect(stripSupportFor("photo.bmp")).toMatchObject({ warn: true });
    expect(stripSupportFor("notes.txt")).toMatchObject({ warn: false });
    expect(stripSupportFor("data.json")).toMatchObject({ warn: false });
  });

  test.each([
    "main.rs",
    "app.py",
    "index.ts",
    "Dockerfile.dockerfile",
    "s.sql",
  ])("recognized text/source extension %s does not warn", (name) => {
    expect(stripSupportFor(name)).toMatchObject({ warn: false });
  });
});

describe("shouldSniffForText", () => {
  test("only unrecognized non-archive files are worth sniffing", () => {
    expect(shouldSniffForText("mystery.xyz")).toBe(true);
    expect(shouldSniffForText("old.doc")).toBe(true);
    // recognized text: fast path, no sniff needed
    expect(shouldSniffForText("main.rs")).toBe(false);
    // fully-cleanable and archives are handled by other paths
    expect(shouldSniffForText("photo.jpg")).toBe(false);
    expect(shouldSniffForText("backup.zip")).toBe(false);
    expect(shouldSniffForText("dump.tar.gz")).toBe(false);
  });
});

describe("looksLikeText", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  test("accepts ascii, whitespace, and utf-8", () => {
    expect(looksLikeText(bytes("hello\tworld\r\n"))).toBe(true);
    expect(looksLikeText(bytes("café — naïve © 2026"))).toBe(true);
    expect(looksLikeText(new Uint8Array(0))).toBe(true);
  });

  test("rejects NUL and stray control bytes", () => {
    expect(looksLikeText(new Uint8Array([0x68, 0x00, 0x69]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0x01, 0x02, 0x03]))).toBe(false);
  });
});

describe("summarizeStripWarnings", () => {
  test("splits unsupported files from archives and dedupes", () => {
    expect(
      summarizeStripWarnings([
        "a.jpg",
        "old.doc",
        "old.doc",
        "backup.zip",
        "dump.tar.gz",
        "notes.txt",
      ]),
    ).toEqual({
      unsupported: ["old.doc"],
      archives: ["backup.zip", "dump.tar.gz"],
    });
  });

  test("clean selection warns about nothing", () => {
    expect(summarizeStripWarnings(["a.jpg", "b.mp4", "c.pdf"])).toEqual({
      unsupported: [],
      archives: [],
    });
  });

  test("sniffed-text names are dropped from unsupported, archives are not", () => {
    expect(
      summarizeStripWarnings(
        ["mystery.xyz", "config.weird", "backup.zip"],
        new Set(["mystery.xyz"]),
      ),
    ).toEqual({
      unsupported: ["config.weird"],
      archives: ["backup.zip"],
    });
  });
});
