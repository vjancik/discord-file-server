import { describe, expect, test } from "bun:test";
import { buildOgHtml, type OgFileInput } from "./og-builder";

const BASE = "https://files.example.com";
const LIMIT = 80_000_000;

function input(overrides: Partial<OgFileInput> = {}): OgFileInput {
  return {
    id: "abc123def456ghi789jk22",
    fileName: "clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 12_500_000,
    kind: "video",
    shortCode: "s1s2s3s4",
    width: 1920,
    height: 1080,
    thumbnailPath: "abc123def456ghi789jk22/thumb.jpg",
    uploaderName: "vix",
    ...overrides,
  };
}

describe("buildOgHtml", () => {
  test("video: og:video points at the raw canonical file with type and dimensions", () => {
    const html = buildOgHtml(input(), BASE, LIMIT);
    expect(html).toContain(
      `<meta property="og:video" content="${BASE}/f/abc123def456ghi789jk22/clip.mp4">`,
    );
    expect(html).toContain(
      '<meta property="og:video:type" content="video/mp4">',
    );
    expect(html).toContain('<meta property="og:video:width" content="1920">');
    expect(html).toContain('<meta property="og:video:height" content="1080">');
    expect(html).toContain(
      `<meta property="og:image" content="${BASE}/f/abc123def456ghi789jk22/thumb.jpg">`,
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://files.example.com/s/s1s2s3s4">',
    );
  });

  test("video without probe data omits dimension tags rather than emitting empty ones", () => {
    const html = buildOgHtml(
      input({ width: null, height: null, thumbnailPath: null }),
      BASE,
      LIMIT,
    );
    expect(html).not.toContain("og:video:width");
    expect(html).not.toContain("og:image");
  });

  test("video over the embed limit: thumbnail card, no player tags", () => {
    const html = buildOgHtml(input({ sizeBytes: 96_000_000 }), BASE, LIMIT);
    expect(html).not.toContain("og:video");
    expect(html).not.toContain('content="player"');
    expect(html).toContain(
      `<meta property="og:image" content="${BASE}/f/abc123def456ghi789jk22/thumb.jpg">`,
    );
    expect(html).toContain(
      '<meta property="og:description" content="96.0 MB — uploaded by vix">',
    );
    expect(html).toContain(
      '<meta property="twitter:card" content="summary_large_image">',
    );
  });

  test("video over the embed limit without a thumbnail: plain summary card", () => {
    const html = buildOgHtml(
      input({ sizeBytes: 96_000_000, thumbnailPath: null }),
      BASE,
      LIMIT,
    );
    expect(html).not.toContain("og:video");
    expect(html).not.toContain("og:image");
    expect(html).toContain('<meta property="twitter:card" content="summary">');
  });

  test("video exactly at the embed limit keeps the player tags", () => {
    const html = buildOgHtml(input({ sizeBytes: LIMIT }), BASE, LIMIT);
    expect(html).toContain("og:video");
  });

  test("image: og:image is the file itself", () => {
    const html = buildOgHtml(
      input({ kind: "image", fileName: "photo.png", mimeType: "image/png" }),
      BASE,
      LIMIT,
    );
    expect(html).toContain(
      `<meta property="og:image" content="${BASE}/f/abc123def456ghi789jk22/photo.png">`,
    );
    expect(html).toContain(
      '<meta property="twitter:card" content="summary_large_image">',
    );
  });

  test("audio: og:audio with mime type", () => {
    const html = buildOgHtml(
      input({ kind: "audio", fileName: "song.mp3", mimeType: "audio/mpeg" }),
      BASE,
      LIMIT,
    );
    expect(html).toContain(
      '<meta property="og:audio:type" content="audio/mpeg">',
    );
  });

  test("non-media: card with filename title and size + uploader description", () => {
    const html = buildOgHtml(
      input({
        kind: "other",
        fileName: "backup.zip",
        mimeType: "application/zip",
      }),
      BASE,
      LIMIT,
    );
    expect(html).toContain('<meta property="og:title" content="backup.zip">');
    expect(html).toContain(
      '<meta property="og:description" content="12.5 MB — uploaded by vix">',
    );
    expect(html).not.toContain("og:video");
  });

  test("escapes HTML in filenames and uploader names", () => {
    const html = buildOgHtml(
      input({
        kind: "other",
        fileName: 'a"b<script>.zip',
        uploaderName: "<img>",
      }),
      BASE,
      LIMIT,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("a&quot;b&lt;script&gt;.zip");
    expect(html).toContain("&lt;img&gt;");
  });
});
