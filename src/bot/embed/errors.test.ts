import { describe, expect, test } from "bun:test";
import { sanitizeYtDlpError } from "./errors";

describe("sanitizeYtDlpError", () => {
  test("wraps URLs in <> to suppress embeds", () => {
    const out = sanitizeYtDlpError(
      "ERROR: [generic] https://example.com/video?x=1 : oops",
    );
    expect(out).toContain("<https://example.com/video?x=1>");
  });

  test("strips ANSI escapes", () => {
    const out = sanitizeYtDlpError("\x1b[31mERROR:\x1b[0m something broke");
    expect(out).toBe("ERROR: something broke");
  });

  test("prefers ERROR: lines over noise", () => {
    const out = sanitizeYtDlpError(
      "[youtube] extracting\nWARNING: slow\nERROR: it failed\n[cleanup] done",
    );
    expect(out).toBe("ERROR: it failed");
  });

  test("maps recognizable failures to friendly one-liners", () => {
    expect(sanitizeYtDlpError("ERROR: Unsupported URL: https://x.test")).toBe(
      "That site isn't supported by yt-dlp.",
    );
    expect(
      sanitizeYtDlpError("ERROR: write failed: No space left on device"),
    ).toContain("scratch space");
  });

  test("truncates to fit a Discord message", () => {
    const out = sanitizeYtDlpError(`ERROR: ${"x".repeat(5000)}`);
    expect(out.length).toBeLessThanOrEqual(1801);
    expect(out.endsWith("…")).toBe(true);
  });

  test("handles empty stderr", () => {
    expect(sanitizeYtDlpError("")).toBe("yt-dlp failed with no output.");
  });
});
