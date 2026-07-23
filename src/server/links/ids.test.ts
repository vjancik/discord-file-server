import { describe, expect, test } from "bun:test";
import { generateFileId, generateShortCode } from "./ids";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("generateFileId", () => {
  test("is 22 chars of base64url (128 bits), URL-safe", () => {
    const id = generateFileId();
    expect(id).toHaveLength(22);
    expect(id).toMatch(BASE64URL);
  });

  test("does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, generateFileId));
    expect(ids.size).toBe(1000);
  });
});

describe("generateShortCode", () => {
  test("is 8 chars of base64url, URL-safe", () => {
    const code = generateShortCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(BASE64URL);
  });

  test("does not repeat in a small sample", () => {
    const codes = new Set(Array.from({ length: 1000 }, generateShortCode));
    expect(codes.size).toBe(1000);
  });
});
