/**
 * ID generation. File IDs are the capability credential (PRD §8): 128 bits of
 * crypto randomness, base64url — unguessable by design. Short codes are the
 * /s/ link path segment; 8 base64url chars (48 bits) with a DB unique index
 * as the collision backstop.
 */

function randomBase64url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

/** 22-char base64url file ID (128 bits). */
export function generateFileId(): string {
  return randomBase64url(16);
}

/** 8-char base64url short code (48 bits). */
export function generateShortCode(): string {
  return randomBase64url(6);
}
