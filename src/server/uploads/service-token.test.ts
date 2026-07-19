import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "@/db/client";
import { createTestDb } from "@/test/db";
import {
  JtiRepository,
  mintServiceToken,
  type ServiceTokenClaims,
  verifyServiceToken,
} from "./service-token";

const SECRET = "test-secret";
const NOW = 1_700_000_000_000;

const claims = (
  over: Partial<ServiceTokenClaims> = {},
): ServiceTokenClaims => ({
  userId: "user-1",
  exp: NOW + 60_000,
  jti: "jti-1",
  ...over,
});

describe("mint/verify", () => {
  test("round-trips valid claims", () => {
    const token = mintServiceToken(SECRET, claims({ maxBytes: 123 }));
    expect(verifyServiceToken(token, [SECRET], NOW)).toEqual(
      claims({ maxBytes: 123 }),
    );
  });

  test("rejects a forged signature", () => {
    const token = mintServiceToken("attacker-secret", claims());
    expect(verifyServiceToken(token, [SECRET], NOW)).toBeNull();
  });

  test("rejects a tampered userId", () => {
    const token = mintServiceToken(SECRET, claims());
    const [, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify(claims({ userId: "victim" })),
      "utf8",
    ).toString("base64url");
    expect(verifyServiceToken(`${forged}.${sig}`, [SECRET], NOW)).toBeNull();
  });

  test("rejects an expired token but tolerates small skew", () => {
    const token = mintServiceToken(SECRET, claims({ exp: NOW - 60_000 }));
    expect(verifyServiceToken(token, [SECRET], NOW)).toBeNull();
    const skewed = mintServiceToken(SECRET, claims({ exp: NOW - 10_000 }));
    expect(verifyServiceToken(skewed, [SECRET], NOW)).not.toBeNull();
  });

  test("accepts the previous secret during rotation", () => {
    const token = mintServiceToken("old-secret", claims());
    expect(
      verifyServiceToken(token, ["new-secret", "old-secret"], NOW),
    ).not.toBeNull();
  });

  test("rejects malformed input without throwing", () => {
    for (const bad of ["", "no-dot", "a.b", "!!!.###"]) {
      expect(verifyServiceToken(bad, [SECRET], NOW)).toBeNull();
    }
  });
});

describe("JtiRepository", () => {
  let db: Db;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
  });
  afterEach(() => cleanup());

  test("consumes once, rejects replay", () => {
    const repo = new JtiRepository(db);
    const exp = new Date(Date.now() + 60_000);
    expect(repo.consume("j1", exp)).toBe(true);
    expect(repo.consume("j1", exp)).toBe(false);
    expect(repo.consume("j2", exp)).toBe(true);
  });

  test("prunes expired rows, freeing their ids", () => {
    const repo = new JtiRepository(db);
    expect(repo.consume("j1", new Date(Date.now() - 1000))).toBe(true);
    // Expired row is pruned on the next consume, so the id is usable again —
    // harmless, since a token with that jti is itself expired.
    expect(repo.consume("j1", new Date(Date.now() + 60_000))).toBe(true);
  });
});
