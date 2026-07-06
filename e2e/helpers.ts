import type { Page } from "@playwright/test";

let seq = 0;

/** Signs up (and in) a fresh user through the E2E_TEST_AUTH credential path. */
export async function signUpAndIn(page: Page): Promise<{ email: string }> {
  const email = `e2e-${Date.now()}-${++seq}@example.com`;
  const res = await page.request.post("/api/auth/sign-up/email", {
    data: { email, password: "e2e-password-123", name: `E2E User ${seq}` },
  });
  if (!res.ok()) {
    throw new Error(`sign-up failed: ${res.status()} ${await res.text()}`);
  }
  return { email };
}

// Small real MP4 header (ftyp box) so type sniffing sees video/mp4, padded so
// the upload is non-trivial in size.
export function fakeMp4Bytes(): Buffer {
  const ftyp = Buffer.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  return Buffer.concat([ftyp, Buffer.alloc(64 * 1024)]);
}

export const DISCORDBOT_UA =
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
