import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "@/db/client";
import { createTestDb, insertTestUser } from "@/test/db";
import type { MediaInfo, MediaProber } from "../media/prober";
import { FileRepository } from "./file.repository";
import { FileService } from "./file.service";
import { FinalizeService, UploadRejectedError } from "./finalize.service";
import { FileStorage } from "./storage";

let db: Db;
let dbCleanup: () => void;
let tmp: string;
let repo: FileRepository;
let storage: FileStorage;
let owner: string;

const fakeProber = (
  info: MediaInfo = { width: 1920, height: 1080, durationSeconds: 42 },
) =>
  ({
    async probe() {
      return info;
    },
    async makeThumbnail(_src, dest, kind) {
      if (kind !== "video" && kind !== "image") return false;
      await Bun.write(dest, "fake-jpeg");
      return true;
    },
  }) satisfies MediaProber;

beforeEach(() => {
  ({ db, cleanup: dbCleanup } = createTestDb());
  tmp = mkdtempSync(path.join(os.tmpdir(), "finalize-test-"));
  mkdirSync(path.join(tmp, "staging"));
  mkdirSync(path.join(tmp, "storage"));
  repo = new FileRepository(db);
  storage = new FileStorage(path.join(tmp, "storage"));
  owner = insertTestUser(db);
});

afterEach(() => {
  dbCleanup();
  rmSync(tmp, { recursive: true, force: true });
});

async function stageFile(
  name: string,
  content: Uint8Array | string,
): Promise<string> {
  const p = path.join(tmp, "staging", name);
  await Bun.write(p, content);
  return p;
}

// tiny valid-enough MP4 head: ftyp box so file-type sniffs video/mp4, not an executable
const MP4_HEAD = new Uint8Array([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69,
  0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

describe("FinalizeService", () => {
  test("publishes a video: probe data, thumbnail, moved bytes, pending row, short code", async () => {
    const staging = await stageFile("upload-1", MP4_HEAD);
    const service = new FinalizeService(repo, storage, fakeProber());

    const row = await service.finalize({
      stagingPath: staging,
      ownerId: owner,
      rawFileName: "My Clip.mp4",
      clientMime: "video/mp4",
      sizeBytes: MP4_HEAD.length,
    });

    expect(row.kind).toBe("video");
    expect(row.status).toBe("pending");
    expect(row.width).toBe(1920);
    expect(row.durationSeconds).toBe(42);
    expect(row.shortCode).toHaveLength(8);
    expect(row.thumbnailPath).toBe(`${row.id}/thumb.jpg`);
    expect(row.expiresAt).toBeNull();

    expect(existsSync(storage.pathFor(row.id, "My Clip.mp4"))).toBe(true);
    expect(existsSync(storage.pathFor(row.id, "thumb.jpg"))).toBe(true);
    expect(existsSync(staging)).toBe(false); // moved out of staging
    expect(repo.findLiveById(row.id)?.id).toBe(row.id);
  });

  test("non-media file: no probe, no thumbnail, kind other", async () => {
    const staging = await stageFile("upload-2", "plain text content");
    const service = new FinalizeService(repo, storage, fakeProber());

    const row = await service.finalize({
      stagingPath: staging,
      ownerId: owner,
      rawFileName: "notes.txt",
      clientMime: "text/plain",
      sizeBytes: 18,
    });

    expect(row.kind).toBe("other");
    expect(row.thumbnailPath).toBeNull();
    expect(row.width).toBeNull();
  });

  test("rejects smuggled executables by content and leaves no trace in storage", async () => {
    const elf = new Uint8Array([
      0x7f,
      0x45,
      0x4c,
      0x46,
      2,
      1,
      1,
      0,
      ...new Array(64).fill(0),
    ]);
    const staging = await stageFile("upload-3", elf);
    const service = new FinalizeService(repo, storage, fakeProber());

    expect(
      service.finalize({
        stagingPath: staging,
        ownerId: owner,
        rawFileName: "innocent.dat",
        sizeBytes: elf.length,
      }),
    ).rejects.toBeInstanceOf(UploadRejectedError);

    const { readdirSync } = await import("node:fs");
    expect(readdirSync(path.join(tmp, "storage"))).toHaveLength(0);
  });

  test("applies DEFAULT_FILE_EXPIRY when configured", async () => {
    const staging = await stageFile("upload-4", "content");
    const service = new FinalizeService(repo, storage, fakeProber(), {
      defaultExpiryMs: 60_000,
    });
    const row = await service.finalize({
      stagingPath: staging,
      ownerId: owner,
      rawFileName: "notes.txt",
      sizeBytes: 7,
    });
    expect(row.expiresAt).toBeInstanceOf(Date);
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("FileService.delete", () => {
  test("removes bytes and tombstones the row", async () => {
    const staging = await stageFile("upload-5", MP4_HEAD);
    const finalize = new FinalizeService(repo, storage, fakeProber());
    const files = new FileService(repo, storage);

    const row = await finalize.finalize({
      stagingPath: staging,
      ownerId: owner,
      rawFileName: "clip.mp4",
      sizeBytes: MP4_HEAD.length,
    });

    await files.delete(row.id, owner);

    expect(existsSync(storage.dirFor(row.id))).toBe(false);
    expect(repo.findLiveById(row.id)).toBeUndefined();
    expect(repo.findById(row.id)?.deletedById).toBe(owner);
  });
});
