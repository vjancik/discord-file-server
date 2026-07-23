import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "@/db/client";
import { createTestDb, insertTestUser } from "@/test/db";
import type { MediaInfo, MediaProber } from "../media/prober";
import { MetadataStripError } from "../metadata/errors";
import type { MetadataStripper } from "../metadata/strip.service";
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
    async thumbnailFromUrl() {
      return false;
    },
  }) satisfies MediaProber;

/** Stripper that just moves, like an unsupported type would. */
const passStripper = (): MetadataStripper => ({
  async deliver({ stagingPath, fileId, fileName }) {
    await storage.moveIntoStorage(stagingPath, fileId, fileName);
    return { metadataStatus: "possible" };
  },
});

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
    const service = new FinalizeService(
      repo,
      storage,
      fakeProber(),
      passStripper(),
    );

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

  test("video: source thumbnail is preferred over the ffmpeg frame-grab", async () => {
    const staging = await stageFile("upload-thumb-src", MP4_HEAD);
    const calls: string[] = [];
    const prober: MediaProber = {
      ...fakeProber(),
      async thumbnailFromUrl(url, dest) {
        calls.push(`fromUrl:${url}`);
        await Bun.write(dest, "poster-jpeg");
        return true;
      },
      async makeThumbnail(_src, dest, kind) {
        calls.push("frameGrab");
        await Bun.write(dest, "fake-jpeg");
        return kind === "video" || kind === "image";
      },
    };
    const service = new FinalizeService(repo, storage, prober, passStripper());

    const row = await service.finalize({
      stagingPath: staging,
      ownerId: owner,
      rawFileName: "clip.mp4",
      clientMime: "video/mp4",
      sizeBytes: MP4_HEAD.length,
      sourceThumbnailUrl: "https://cdn.test/poster.jpg",
    });

    expect(calls).toEqual(["fromUrl:https://cdn.test/poster.jpg"]);
    expect(row.thumbnailPath).toBe(`${row.id}/thumb.jpg`);
    expect(existsSync(storage.pathFor(row.id, "thumb.jpg"))).toBe(true);
  });

  test("video: falls back to the frame-grab when the source thumbnail fails", async () => {
    const staging = await stageFile("upload-thumb-fallback", MP4_HEAD);
    const calls: string[] = [];
    const prober: MediaProber = {
      ...fakeProber(),
      async thumbnailFromUrl(url) {
        calls.push(`fromUrl:${url}`);
        return false; // unreachable / undecodable poster
      },
      async makeThumbnail(_src, dest, kind) {
        calls.push("frameGrab");
        await Bun.write(dest, "fake-jpeg");
        return kind === "video" || kind === "image";
      },
    };
    const service = new FinalizeService(repo, storage, prober, passStripper());

    const row = await service.finalize({
      stagingPath: staging,
      ownerId: owner,
      rawFileName: "clip.mp4",
      clientMime: "video/mp4",
      sizeBytes: MP4_HEAD.length,
      sourceThumbnailUrl: "https://cdn.test/poster.jpg",
    });

    expect(calls).toEqual(["fromUrl:https://cdn.test/poster.jpg", "frameGrab"]);
    expect(row.thumbnailPath).toBe(`${row.id}/thumb.jpg`);
  });

  test("non-media file: no probe, no thumbnail, kind other", async () => {
    const staging = await stageFile("upload-2", "plain text content");
    const service = new FinalizeService(
      repo,
      storage,
      fakeProber(),
      passStripper(),
    );

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
    const service = new FinalizeService(
      repo,
      storage,
      fakeProber(),
      passStripper(),
    );

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
    const service = new FinalizeService(
      repo,
      storage,
      fakeProber(),
      passStripper(),
      {
        defaultExpiryMs: 60_000,
      },
    );
    const row = await service.finalize({
      stagingPath: staging,
      ownerId: owner,
      rawFileName: "notes.txt",
      sizeBytes: 7,
    });
    expect(row.expiresAt).toBeInstanceOf(Date);
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  test("persists metadata_status=stripped when the stripper cleans the file", async () => {
    const staging = await stageFile("upload-strip", MP4_HEAD);
    const stripper: MetadataStripper = {
      async deliver({ stagingPath, fileId, fileName }) {
        await storage.moveIntoStorage(stagingPath, fileId, fileName);
        return { metadataStatus: "stripped" };
      },
    };
    const service = new FinalizeService(repo, storage, fakeProber(), stripper);

    const row = await service.finalize({
      stagingPath: staging,
      ownerId: owner,
      rawFileName: "clip.mp4",
      sizeBytes: MP4_HEAD.length,
      strip: { media: true, documents: true },
    });

    expect(row.metadataStatus).toBe("stripped");
    expect(repo.findLiveById(row.id)?.metadataStatus).toBe("stripped");
  });

  test("passes strip flags through and defaults them to on", async () => {
    const seen: unknown[] = [];
    const stripper: MetadataStripper = {
      async deliver(input) {
        seen.push(input.flags);
        await storage.moveIntoStorage(
          input.stagingPath,
          input.fileId,
          input.fileName,
        );
        return { metadataStatus: "possible" };
      },
    };
    const service = new FinalizeService(repo, storage, fakeProber(), stripper);

    const s1 = await stageFile("upload-flags-1", "content");
    await service.finalize({
      stagingPath: s1,
      ownerId: owner,
      rawFileName: "a.txt",
      sizeBytes: 7,
      strip: { media: false, documents: true },
    });
    const s2 = await stageFile("upload-flags-2", "content");
    const row = await service.finalize({
      stagingPath: s2,
      ownerId: owner,
      rawFileName: "b.txt",
      sizeBytes: 7,
    });

    expect(seen).toEqual([
      { media: false, documents: true },
      { media: true, documents: true },
    ]);
    expect(row.metadataStatus).toBe("possible");
  });

  test("maps a strip failure to UploadRejectedError and rolls back storage", async () => {
    const staging = await stageFile("upload-strip-fail", MP4_HEAD);
    const stripper: MetadataStripper = {
      async deliver() {
        throw new MetadataStripError("ffmpeg could not process the file");
      },
    };
    const service = new FinalizeService(repo, storage, fakeProber(), stripper);

    await expect(
      service.finalize({
        stagingPath: staging,
        ownerId: owner,
        rawFileName: "clip.mp4",
        sizeBytes: MP4_HEAD.length,
      }),
    ).rejects.toBeInstanceOf(UploadRejectedError);

    const { readdirSync } = await import("node:fs");
    expect(readdirSync(path.join(tmp, "storage"))).toHaveLength(0);
  });
});

describe("FileService.delete", () => {
  test("removes bytes and tombstones the row", async () => {
    const staging = await stageFile("upload-5", MP4_HEAD);
    const finalize = new FinalizeService(
      repo,
      storage,
      fakeProber(),
      passStripper(),
    );
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
