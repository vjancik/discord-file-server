import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

// A real (tiny) MP4: finalize now remuxes video uploads to strip metadata,
// so a fake ftyp-plus-zeros fixture would be rejected by ffmpeg. ffmpeg is
// already a hard e2e dependency (probe/thumbnail), so generate 1 s of testsrc
// once per worker.
let mp4Cache: Buffer | undefined;
export function testMp4Bytes(): Buffer {
  if (!mp4Cache) {
    const file = path.join(
      mkdtempSync(path.join(os.tmpdir(), "e2e-mp4-")),
      "clip.mp4",
    );
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=1:size=64x64:rate=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-shortest",
      file,
    ]);
    mp4Cache = readFileSync(file);
  }
  return mp4Cache;
}

export const DISCORDBOT_UA =
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
