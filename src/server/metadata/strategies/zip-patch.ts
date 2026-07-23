import { open } from "node:fs/promises";
import { MetadataStripError } from "../errors";

/**
 * In-place zip *container* cleaning: entry mtimes → 1980-01-01, extra-field
 * payloads zeroed (Unix uid/gid, NTFS/UT timestamps), entry + archive
 * comments blanked. Runs after the file already sits at its final storage
 * path: every patch overwrites bytes at fixed offsets, so the file size never
 * changes and no staging/storage headroom is needed.
 *
 * Entry *contents* are never touched — a zip of photos still has EXIF inside;
 * that is why zip uploads keep `metadata_status = "possible"`.
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** DOS date 1980-01-01 (day 1, month 1, year offset 0); time 00:00:00. */
const DOS_DATE_EPOCH = 0x0021;

/** A central directory larger than this is not a legitimate upload. */
const MAX_CD_BYTES = 64 * 1024 * 1024;

/**
 * Extra-field ids whose payload must survive: zip64 (sizes/offsets live
 * there) and encryption headers. Everything else — UT (0x5455) and Info-ZIP
 * Unix (0x7855/0x7875) timestamps/uid/gid, NTFS times (0x000a) — is zeroed,
 * keeping the TLV structure so parsers still walk the region cleanly.
 */
const KEEP_EXTRA_IDS = new Set([0x0001, 0x9901, 0x0017]);

const bad = (msg: string) =>
  new MetadataStripError(`Zip container cleaning failed: ${msg}`);

/** Zeroes non-structural TLV payloads inside an extra-field region. */
function wipeExtraField(buf: Buffer, start: number, len: number): void {
  let pos = start;
  const end = start + len;
  while (pos + 4 <= end) {
    const id = buf.readUInt16LE(pos);
    const size = buf.readUInt16LE(pos + 2);
    if (pos + 4 + size > end) break; // malformed TLV: zero the remainder below
    if (!KEEP_EXTRA_IDS.has(id)) buf.fill(0, pos + 4, pos + 4 + size);
    pos += 4 + size;
  }
  if (pos < end) buf.fill(0, pos, end);
}

export async function patchZipInPlace(filePath: string): Promise<void> {
  const fh = await open(filePath, "r+");
  try {
    const { size } = await fh.stat();
    if (size < 22) throw bad("file too small to be a zip");

    // EOCD: fixed 22 bytes + up to 64 KB of archive comment; scan backwards.
    const tailLen = Math.min(size, 22 + 0xffff);
    const tailStart = size - tailLen;
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, tailStart);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw bad("end-of-central-directory not found");
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0)
      throw bad("multi-disk archives are not supported");

    let cdOffset: number = tail.readUInt32LE(eocd + 16);
    let cdSize: number = tail.readUInt32LE(eocd + 12);

    // Blank the archive comment in place (spaces keep it valid text).
    const commentLen = tail.readUInt16LE(eocd + 20);
    if (commentLen > 0) {
      const spaces = Buffer.alloc(commentLen, 0x20);
      await fh.write(spaces, 0, commentLen, tailStart + eocd + 22);
    }

    // zip64: the real cd offset/size live in the EOCD64 record, found via the
    // locator that directly precedes the EOCD.
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      const locPos = tailStart + eocd - 20;
      const loc = Buffer.alloc(20);
      await fh.read(loc, 0, 20, locPos);
      if (loc.readUInt32LE(0) !== EOCD64_LOC_SIG)
        throw bad("zip64 locator not found");
      const eocd64Pos = Number(loc.readBigUInt64LE(8));
      const eocd64 = Buffer.alloc(56);
      await fh.read(eocd64, 0, 56, eocd64Pos);
      if (eocd64.readUInt32LE(0) !== EOCD64_SIG)
        throw bad("zip64 end record not found");
      cdSize = Number(eocd64.readBigUInt64LE(40));
      cdOffset = Number(eocd64.readBigUInt64LE(48));
    }

    if (cdSize > MAX_CD_BYTES) throw bad("central directory too large");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    let pos = 0;
    while (pos + 46 <= cdSize) {
      if (cd.readUInt32LE(pos) !== CENTRAL_SIG)
        throw bad("central directory entry corrupt");
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const entryCommentLen = cd.readUInt16LE(pos + 32);
      let localOffset: number = cd.readUInt32LE(pos + 42);

      // zip64 extra: read the true local-header offset *before* wiping (its
      // payload is on the keep-list, but order still matters for clarity).
      if (localOffset === 0xffffffff) {
        localOffset = readZip64LocalOffset(cd, pos + 46 + nameLen, extraLen);
        if (localOffset === -1) throw bad("zip64 local offset missing");
      }

      cd.writeUInt16LE(0, pos + 12); // mod time → 00:00
      cd.writeUInt16LE(DOS_DATE_EPOCH, pos + 14); // mod date → 1980-01-01
      wipeExtraField(cd, pos + 46 + nameLen, extraLen);
      cd.fill(
        0x20,
        pos + 46 + nameLen + extraLen,
        pos + 46 + nameLen + extraLen + entryCommentLen,
      );

      await patchLocalHeader(fh, localOffset);
      pos += 46 + nameLen + extraLen + entryCommentLen;
    }

    await fh.write(cd, 0, cdSize, cdOffset);
  } finally {
    await fh.close();
  }
}

/** Local-header timestamps and extras mirror the central ones — patch both. */
async function patchLocalHeader(
  fh: Awaited<ReturnType<typeof open>>,
  offset: number,
): Promise<void> {
  const head = Buffer.alloc(30);
  await fh.read(head, 0, 30, offset);
  if (head.readUInt32LE(0) !== LOCAL_SIG) throw bad("local header corrupt");
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(DOS_DATE_EPOCH, 12);
  await fh.write(head, 10, 4, offset + 10); // just the time+date fields
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  if (extraLen > 0) {
    const extra = Buffer.alloc(extraLen);
    const extraPos = offset + 30 + nameLen;
    await fh.read(extra, 0, extraLen, extraPos);
    wipeExtraField(extra, 0, extraLen);
    await fh.write(extra, 0, extraLen, extraPos);
  }
}

/** Finds the local-header offset inside a zip64 (0x0001) extra field. */
function readZip64LocalOffset(cd: Buffer, start: number, len: number): number {
  const entryStart = start - 46; // walk back for the 0xffffffff markers
  let pos = start;
  const end = start + len;
  while (pos + 4 <= end) {
    const id = cd.readUInt16LE(pos);
    const size = cd.readUInt16LE(pos + 2);
    if (pos + 4 + size > end) return -1;
    if (id === 0x0001) {
      // Fields present only for values that overflowed, in fixed order:
      // uncompressed size, compressed size, local offset, disk number.
      let fieldPos = pos + 4;
      if (cd.readUInt32LE(entryStart + 24) === 0xffffffff) fieldPos += 8;
      if (cd.readUInt32LE(entryStart + 20) === 0xffffffff) fieldPos += 8;
      if (fieldPos + 8 > pos + 4 + size) return -1;
      return Number(cd.readBigUInt64LE(fieldPos));
    }
    pos += 4 + size;
  }
  return -1;
}
