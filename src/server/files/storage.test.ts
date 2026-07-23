import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStorage } from "./storage";

let tmp: string;
let storage: FileStorage;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "storage-test-"));
  storage = new FileStorage(path.join(tmp, "storage"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function stageFile(name: string, content: string): Promise<string> {
  const p = path.join(tmp, name);
  await Bun.write(p, content);
  return p;
}

describe("FileStorage", () => {
  test("moveIntoStorage renames the source into the file's directory", async () => {
    const source = await stageFile("upload-1", "file bytes");

    const dest = await storage.moveIntoStorage(source, "file-1", "clip.mp4");

    expect(dest).toBe(storage.pathFor("file-1", "clip.mp4"));
    expect(await Bun.file(dest).text()).toBe("file bytes");
    expect(existsSync(source)).toBe(false);
  });

  test("copyIntoStorage (EXDEV fallback) lands the file and removes the source and temp", async () => {
    const source = await stageFile("upload-2", "cross-device bytes");
    // moveIntoStorage creates the dir before falling back; mirror that here.
    await storage.moveIntoStorage(
      await stageFile("upload-3", "x"),
      "file-2",
      "seed.bin",
    );

    const dest = await storage.copyIntoStorage(source, "file-2", "clip.mp4");

    expect(await Bun.file(dest).text()).toBe("cross-device bytes");
    expect(existsSync(source)).toBe(false);
    // The .incoming temp must be gone: Caddy serves this directory as-is.
    expect(readdirSync(storage.dirFor("file-2")).sort()).toEqual([
      "clip.mp4",
      "seed.bin",
    ]);
  });
});
