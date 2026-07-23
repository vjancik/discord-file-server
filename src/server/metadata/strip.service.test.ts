import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStorage } from "../files/storage";
import { MetadataStripError } from "./errors";
import { MetadataStripService, type StripStrategies } from "./strip.service";

let tmp: string;
let storage: FileStorage;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "strip-svc-test-"));
  mkdirSync(path.join(tmp, "staging"));
  mkdirSync(path.join(tmp, "storage"));
  storage = new FileStorage(path.join(tmp, "storage"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function stage(name: string, content = "original-bytes") {
  const p = path.join(tmp, "staging", name);
  await Bun.write(p, content);
  return p;
}

/** Fake strategies that record calls and write marker output. */
function fakes(calls: string[]): Partial<StripStrategies> {
  const write = (label: string) => async (_src: string, dest: string) => {
    calls.push(label);
    await Bun.write(dest, `cleaned-by-${label}`);
  };
  return {
    image: write("image"),
    av: async (_src, dest, kind, ext) => {
      calls.push(`av:${kind}:${ext}`);
      await Bun.write(dest, "cleaned-by-av");
    },
    pdf: write("pdf"),
    office: async (_src, dest, ext) => {
      calls.push(`office:${ext}`);
      await Bun.write(dest, "cleaned-by-office");
    },
    zipPatch: async (dest) => {
      calls.push(`zipPatch:${path.basename(dest)}`);
    },
  };
}

const ON = { media: true, documents: true };
const OFF = { media: false, documents: false };

describe("MetadataStripService.deliver", () => {
  test("routes a jpeg through the image strategy, atomically, and consumes staging", async () => {
    const calls: string[] = [];
    const svc = new MetadataStripService(storage, fakes(calls));
    const staging = await stage("up-1");

    const res = await svc.deliver({
      stagingPath: staging,
      fileId: "f1",
      fileName: "photo.jpg",
      kind: "image",
      flags: ON,
    });

    expect(res.metadataStatus).toBe("stripped");
    expect(calls).toEqual(["image"]);
    expect(await Bun.file(storage.pathFor("f1", "photo.jpg")).text()).toBe(
      "cleaned-by-image",
    );
    expect(existsSync(staging)).toBe(false);
    // no leftover temp
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(storage.dirFor("f1"))).toEqual(["photo.jpg"]);
  });

  test("audio routes to av with audio mapping; video keeps its kind", async () => {
    const calls: string[] = [];
    const svc = new MetadataStripService(storage, fakes(calls));

    await svc.deliver({
      stagingPath: await stage("up-a"),
      fileId: "fa",
      fileName: "song.mp3",
      kind: "audio",
      flags: ON,
    });
    await svc.deliver({
      stagingPath: await stage("up-v"),
      fileId: "fv",
      fileName: "clip.mkv",
      kind: "video",
      flags: ON,
    });

    expect(calls).toEqual(["av:audio:mp3", "av:video:mkv"]);
  });

  test("pdf and office route via the documents toggle", async () => {
    const calls: string[] = [];
    const svc = new MetadataStripService(storage, fakes(calls));

    await svc.deliver({
      stagingPath: await stage("up-p"),
      fileId: "fp",
      fileName: "report.pdf",
      kind: "other",
      flags: ON,
    });
    await svc.deliver({
      stagingPath: await stage("up-d"),
      fileId: "fd",
      fileName: "doc.docx",
      kind: "other",
      flags: ON,
    });

    expect(calls).toEqual(["pdf", "office:docx"]);
  });

  test("zip: moved first, then patched in place, and stays metadata_status=possible", async () => {
    const calls: string[] = [];
    const svc = new MetadataStripService(storage, fakes(calls));
    const staging = await stage("up-z", "zip-bytes");

    const res = await svc.deliver({
      stagingPath: staging,
      fileId: "fz",
      fileName: "backup.zip",
      kind: "other",
      flags: ON,
    });

    expect(res.metadataStatus).toBe("possible");
    expect(calls).toEqual(["zipPatch:backup.zip"]);
    // moved, not rewritten: original bytes at the destination
    expect(await Bun.file(storage.pathFor("fz", "backup.zip")).text()).toBe(
      "zip-bytes",
    );
    expect(existsSync(staging)).toBe(false);
  });

  test("toggle off on a cleanable type: plain move, metadata_status=possible", async () => {
    const calls: string[] = [];
    const svc = new MetadataStripService(storage, fakes(calls));

    const r1 = await svc.deliver({
      stagingPath: await stage("up-off", "as-is"),
      fileId: "fo",
      fileName: "photo.jpg",
      kind: "image",
      flags: OFF,
    });

    expect(calls).toEqual([]);
    expect(r1.metadataStatus).toBe("possible");
    expect(await Bun.file(storage.pathFor("fo", "photo.jpg")).text()).toBe(
      "as-is",
    );
  });

  test("known text extension records metadata_status=none without a strategy", async () => {
    const calls: string[] = [];
    const svc = new MetadataStripService(storage, fakes(calls));

    const res = await svc.deliver({
      stagingPath: await stage("up-txt", "hello"),
      fileId: "ft",
      fileName: "notes.txt",
      kind: "other",
      flags: ON,
    });

    expect(calls).toEqual([]);
    expect(res.metadataStatus).toBe("none");
  });

  test("unrecognized extension is content-sniffed: text → none", async () => {
    const svc = new MetadataStripService(storage, {});
    const res = await svc.deliver({
      stagingPath: await stage("up-x", "just plain text\nlines\n"),
      fileId: "fx",
      fileName: "mystery.xyz",
      kind: "other",
      flags: ON,
    });
    expect(res.metadataStatus).toBe("none");
  });

  test("unrecognized extension is content-sniffed: binary → possible", async () => {
    const svc = new MetadataStripService(storage, {});
    // A NUL byte in the prefix marks the file binary.
    const staging = path.join(tmp, "staging", "up-b");
    await Bun.write(staging, new Uint8Array([0x74, 0x78, 0x00, 0x62, 0x69]));
    const res = await svc.deliver({
      stagingPath: staging,
      fileId: "fb",
      fileName: "mystery.xyz",
      kind: "other",
      flags: ON,
    });
    expect(res.metadataStatus).toBe("possible");
  });

  test("media and documents toggles are independent", async () => {
    const calls: string[] = [];
    const svc = new MetadataStripService(storage, fakes(calls));

    await svc.deliver({
      stagingPath: await stage("up-m"),
      fileId: "fm",
      fileName: "photo.jpg",
      kind: "image",
      flags: { media: false, documents: true },
    });
    await svc.deliver({
      stagingPath: await stage("up-doc"),
      fileId: "fdoc",
      fileName: "report.pdf",
      kind: "other",
      flags: { media: false, documents: true },
    });

    expect(calls).toEqual(["pdf"]);
  });

  test("a failing strategy leaves no temp file, keeps staging, and rethrows", async () => {
    const svc = new MetadataStripService(storage, {
      image: async () => {
        throw new MetadataStripError("boom");
      },
    });
    const staging = await stage("up-fail");

    await expect(
      svc.deliver({
        stagingPath: staging,
        fileId: "ff",
        fileName: "photo.jpg",
        kind: "image",
        flags: ON,
      }),
    ).rejects.toBeInstanceOf(MetadataStripError);

    expect(existsSync(staging)).toBe(true); // caller's cleanup, not ours
    expect(existsSync(storage.pathFor("ff", "photo.jpg"))).toBe(false);
  });
});
