import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EmbedVerifier } from "./verify";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "verify-test-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function fileOfSize(name: string, bytes: number): string {
  const p = path.join(tmp, name);
  writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

const probeReturning = (formatName: string | null) => async () =>
  formatName === null
    ? null
    : JSON.stringify({ format: { format_name: formatName } });

describe("EmbedVerifier", () => {
  test("mp4 within the limit is embeddable", async () => {
    const v = new EmbedVerifier(probeReturning("mov,mp4,m4a,3gp,3g2,mj2"));
    const check = await v.verify(fileOfSize("a.mp4", 100), 1000);
    expect(check).toEqual({
      sizeBytes: 100,
      container: "mp4",
      embeddable: true,
    });
  });

  test("webm is recognized via matroska,webm + extension", async () => {
    const v = new EmbedVerifier(probeReturning("matroska,webm"));
    const check = await v.verify(fileOfSize("a.webm", 100), 1000);
    expect(check.embeddable).toBe(true);
    expect(check.container).toBe("webm");
  });

  test("mkv (matroska without .webm extension) is not embeddable", async () => {
    const v = new EmbedVerifier(probeReturning("matroska,webm"));
    const check = await v.verify(fileOfSize("a.mkv", 100), 1000);
    expect(check.embeddable).toBe(false);
    expect(check.reason).toContain("doesn't inline-embed");
  });

  test("over the size limit is not embeddable, with sizes in the reason", async () => {
    const v = new EmbedVerifier(probeReturning("mov,mp4,m4a,3gp,3g2,mj2"));
    const check = await v.verify(fileOfSize("big.mp4", 2000), 1000);
    expect(check.embeddable).toBe(false);
    expect(check.reason).toContain("embed limit");
  });

  test("unreadable file is not embeddable", async () => {
    const v = new EmbedVerifier(probeReturning(null));
    const check = await v.verify(fileOfSize("junk.mp4", 10), 1000);
    expect(check.embeddable).toBe(false);
    expect(check.container).toBe("unreadable");
  });
});
