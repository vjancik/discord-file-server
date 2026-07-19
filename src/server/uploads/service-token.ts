import { createHmac, timingSafeEqual } from "node:crypto";
import { lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { serviceTokenJtis } from "@/db/schema";

/**
 * Upload service tokens (docs/embed-auth.md): compact HMAC-SHA256 tokens the
 * bot mints to upload through the tus endpoint as a specific user. Format is
 * `base64url(payload).base64url(sig)` — deliberately not a JWT (no header, no
 * alg negotiation).
 */
export type ServiceTokenClaims = {
  userId: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Single-use id; consumed at upload creation. */
  jti: string;
  /** Optional per-upload byte cap. */
  maxBytes?: number;
};

/** Tolerated clock skew between minter and verifier. */
const EXP_LEEWAY_MS = 30_000;

const b64url = (buf: Buffer) => buf.toString("base64url");

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function mintServiceToken(
  secret: string,
  claims: ServiceTokenClaims,
): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payload}.${b64url(sign(payload, secret))}`;
}

/**
 * Signature + expiry check against every configured secret (rotation window).
 * Returns the claims or null; never throws on malformed input. Single-use
 * (jti) enforcement is separate — see JtiRepository — because tus needs
 * multiple requests per upload and only creation consumes the jti.
 */
export function verifyServiceToken(
  token: string,
  secrets: readonly string[],
  now = Date.now(),
): ServiceTokenClaims | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const matches = secrets.some((secret) => {
    const expected = sign(payload, secret);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { userId, exp, jti, maxBytes } = claims as Record<string, unknown>;
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof exp !== "number" || typeof jti !== "string" || jti.length === 0)
    return null;
  if (maxBytes !== undefined && typeof maxBytes !== "number") return null;
  if (exp + EXP_LEEWAY_MS < now) return null;
  return { userId, exp, jti, maxBytes };
}

/** DB-backed single-use jti registry; shared so replay protection survives restarts. */
export class JtiRepository {
  constructor(private readonly db: Db) {}

  /**
   * Marks a jti as used. Returns false if it was already consumed. Prunes
   * expired rows opportunistically — the table stays a handful of rows.
   */
  consume(jti: string, expiresAt: Date): boolean {
    this.db
      .delete(serviceTokenJtis)
      .where(lt(serviceTokenJtis.expiresAt, new Date()))
      .run();
    const inserted = this.db
      .insert(serviceTokenJtis)
      .values({ jti, expiresAt })
      .onConflictDoNothing()
      .returning({ jti: serviceTokenJtis.jti })
      .all();
    return inserted.length > 0;
  }
}
