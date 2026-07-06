import { describe, expect, test } from "bun:test";
import { isEmbedCrawler } from "./ua";

describe("isEmbedCrawler", () => {
  test("matches Discordbot (the product target)", () => {
    expect(
      isEmbedCrawler(
        "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      ),
    ).toBe(true);
  });

  test("matches other embed crawlers", () => {
    expect(isEmbedCrawler("Twitterbot/1.0")).toBe(true);
    expect(isEmbedCrawler("TelegramBot (like TwitterBot)")).toBe(true);
  });

  test("does not match browsers or curl", () => {
    expect(
      isEmbedCrawler(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0",
      ),
    ).toBe(false);
    expect(isEmbedCrawler("curl/8.5.0")).toBe(false);
    expect(isEmbedCrawler(null)).toBe(false);
  });
});
