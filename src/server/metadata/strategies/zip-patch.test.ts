import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { MetadataStripError } from "../errors";
import { patchZipInPlace } from "./zip-patch";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "zip-patch-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const DOS_TIME = 0x6c2f; // 13:33:30
const DOS_DATE = 0x58e5; // 2024-07-05

/**
 * Hand-built stored zip with everything the patcher must clean: real
 * timestamps, UT (0x5455) + Info-ZIP unix uid/gid (0x7875) extra fields in
 * both header copies, an entry comment and an archive comment. fflate writes
 * none of those, so the fixture is built byte-by-byte.
 */
function buildDirtyZip(): Buffer {
  const name = Buffer.from("secret.txt");
  const data = Buffer.from("hello zip");
  const crc = Bun.hash.crc32(data);

  const ut = Buffer.alloc(9); // UT: flags + mtime
  ut.writeUInt16LE(0x5455, 0);
  ut.writeUInt16LE(5, 2);
  ut.writeUInt8(1, 4);
  ut.writeUInt32LE(1720000000, 5);
  const ux = Buffer.alloc(15); // 0x7875: ver, uid, gid
  ux.writeUInt16LE(0x7875, 0);
  ux.writeUInt16LE(11, 2);
  ux.writeUInt8(1, 4);
  ux.writeUInt8(4, 5);
  ux.writeUInt32LE(1000, 6);
  ux.writeUInt8(4, 10);
  ux.writeUInt32LE(1000, 11);
  const extra = Buffer.concat([ut, ux]);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(extra.length, 28);

  const comment = Buffer.from("by john");
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4); // made by unix
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt16LE(comment.length, 32);
  central.writeUInt32LE(0, 42); // local offset

  const localPart = Buffer.concat([local, name, extra, data]);
  const centralPart = Buffer.concat([central, name, extra, comment]);
  const archiveComment = Buffer.from("archive by john");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(archiveComment.length, 20);

  return Buffer.concat([localPart, centralPart, eocd, archiveComment]);
}

describe("patchZipInPlace", () => {
  test("zeroes timestamps, uid/gid extras and comments without touching contents", async () => {
    const file = path.join(tmp, "dirty.zip");
    const original = buildDirtyZip();
    await Bun.write(file, original);

    await patchZipInPlace(file);

    const patched = Buffer.from(await Bun.file(file).arrayBuffer());
    expect(patched.length).toBe(original.length); // strictly in place

    // still a valid zip with identical contents
    const entries = unzipSync(new Uint8Array(patched));
    expect(new TextDecoder().decode(entries["secret.txt"])).toBe("hello zip");

    // local header: time zeroed, date → 1980-01-01
    expect(patched.readUInt16LE(10)).toBe(0);
    expect(patched.readUInt16LE(12)).toBe(0x0021);
    // local UT payload zeroed (extra starts after 30-byte header + name)
    const localExtra = 30 + "secret.txt".length;
    expect(patched.readUInt8(localExtra + 4)).toBe(0); // UT flags byte
    expect(patched.readUInt32LE(localExtra + 5)).toBe(0); // UT mtime
    // local ux uid/gid zeroed
    expect(patched.readUInt32LE(localExtra + 9 + 6)).toBe(0);

    // central copy too
    const cdStart = patched.readUInt32LE(
      patched.length - 22 - "archive by john".length + 16,
    );
    expect(patched.readUInt16LE(cdStart + 12)).toBe(0);
    expect(patched.readUInt16LE(cdStart + 14)).toBe(0x0021);

    // comments blanked to spaces
    expect(
      patched.subarray(patched.length - "archive by john".length).toString(),
    ).toBe(" ".repeat("archive by john".length));
    expect(patched.includes(Buffer.from("by john"))).toBe(false);
  });

  test("keeps fflate-built deflated multi-entry zips valid and content-identical", async () => {
    const file = path.join(tmp, "built.zip");
    const zipped = zipSync(
      {
        "a/one.txt": new TextEncoder().encode("first file"),
        "two.bin": new Uint8Array(1024).fill(7),
      },
      { mtime: new Date("2024-06-01T12:00:00Z") },
    );
    await Bun.write(file, zipped);

    await patchZipInPlace(file);

    const entries = unzipSync(
      new Uint8Array(await Bun.file(file).arrayBuffer()),
    );
    expect(new TextDecoder().decode(entries["a/one.txt"])).toBe("first file");
    expect(entries["two.bin"]).toEqual(new Uint8Array(1024).fill(7));
  });

  test("rejects non-zip bytes", async () => {
    const file = path.join(tmp, "not.zip");
    await Bun.write(file, "definitely not a zip archive, but long enough");
    await expect(patchZipInPlace(file)).rejects.toBeInstanceOf(
      MetadataStripError,
    );
  });
});
