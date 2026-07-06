import { describe, expect, test } from "bun:test";
import { formatBytes, parseBytes, parseDuration } from "./units";

describe("parseBytes", () => {
  test("plain integers are bytes", () => {
    expect(parseBytes("1073741824")).toBe(1073741824);
    expect(parseBytes("0")).toBe(0);
  });

  test("decimal unit suffixes", () => {
    expect(parseBytes("500GB")).toBe(500 * 1000 ** 3);
    expect(parseBytes("1.5tb")).toBe(1.5 * 1000 ** 4);
    expect(parseBytes("250 MB")).toBe(250 * 1000 ** 2);
  });

  test("binary unit suffixes", () => {
    expect(parseBytes("1GiB")).toBe(1024 ** 3);
    expect(parseBytes("512MiB")).toBe(512 * 1024 ** 2);
  });

  test("fractional results are floored to whole bytes", () => {
    expect(parseBytes("1.5B")).toBe(1);
  });

  test("rejects garbage", () => {
    expect(() => parseBytes("")).toThrow();
    expect(() => parseBytes("GB")).toThrow();
    expect(() => parseBytes("10 parsecs")).toThrow();
    expect(() => parseBytes("-5GB")).toThrow();
  });
});

describe("parseDuration", () => {
  test("plain integers are seconds", () => {
    expect(parseDuration("90")).toBe(90_000);
  });

  test("unit suffixes", () => {
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    expect(parseDuration("12h")).toBe(12 * 3_600_000);
    expect(parseDuration("1w")).toBe(7 * 86_400_000);
    expect(parseDuration("15m")).toBe(15 * 60_000);
  });

  test("rejects garbage", () => {
    expect(() => parseDuration("")).toThrow();
    expect(() => parseDuration("soon")).toThrow();
    expect(() => parseDuration("5y")).toThrow();
  });
});

describe("formatBytes", () => {
  test("formats across magnitudes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
    expect(formatBytes(3_000_000_000)).toBe("3.0 GB");
    expect(formatBytes(150_000_000_000)).toBe("150 GB");
  });
});
