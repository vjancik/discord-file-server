import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { FileKind, MetadataStatus } from "@/db/schema";
import { extensionOf } from "@/lib/blocked-extensions";
import { createLogger } from "@/lib/logger";
import {
  hasNoMetadataChannel,
  looksLikeText,
  shouldSniffForText,
  stripSupportFor,
  TEXT_SNIFF_BYTES,
} from "@/lib/metadata-support";
import type { FileStorage } from "../files/storage";
import { stripAv } from "./strategies/av";
import { stripImage } from "./strategies/image";
import { stripOffice } from "./strategies/office";
import { stripPdf } from "./strategies/pdf";
import { patchZipInPlace } from "./strategies/zip-patch";

/** Per-user toggles, resolved from settings by the caller (tus hook). */
export interface StripFlags {
  media: boolean;
  documents: boolean;
}

export interface DeliverInput {
  /** Completed upload in the staging dir; consumed on success. */
  stagingPath: string;
  fileId: string;
  /** Sanitized name — becomes the final storage filename. */
  fileName: string;
  kind: FileKind;
  flags: StripFlags;
}

export interface DeliverResult {
  /**
   * What the pipeline could promise about this file's metadata; see
   * {@link MetadataStatus}. `stripped` only after a full strip; `none` for
   * formats with no metadata channel (text/source/config); `possible` for
   * everything else — toggle off, uncleanable format, or a container-cleaned
   * zip whose contents are untouched.
   */
  metadataStatus: MetadataStatus;
}

/**
 * Port between finalize and the stripping machinery: finalize hands over the
 * staged bytes and gets a published file at the storage path either way —
 * whether they were cleaned or plainly moved stays encapsulated here.
 */
export interface MetadataStripper {
  deliver(input: DeliverInput): Promise<DeliverResult>;
}

const log = createLogger("metadata-strip");

/**
 * Server-side counterpart to the upload page's content sniff: reads the first
 * {@link TEXT_SNIFF_BYTES} of a file and applies the same {@link looksLikeText}
 * heuristic, so an unrecognized-extension upload of plain text is recorded as
 * `metadata_status = "none"`. Reused code, not trusted client input. On any
 * read error we fall back to "not text" so the file stays `"possible"`.
 */
async function sniffFileAsText(filePath: string): Promise<boolean> {
  try {
    const prefix = Bun.file(filePath).slice(0, TEXT_SNIFF_BYTES);
    return looksLikeText(new Uint8Array(await prefix.arrayBuffer()));
  } catch {
    return false;
  }
}

/** Strategy functions, injectable so orchestration is testable without tools. */
export interface StripStrategies {
  image: typeof stripImage;
  av: typeof stripAv;
  pdf: typeof stripPdf;
  office: typeof stripOffice;
  zipPatch: typeof patchZipInPlace;
}

const REAL_STRATEGIES: StripStrategies = {
  image: stripImage,
  av: stripAv,
  pdf: stripPdf,
  office: stripOffice,
  zipPatch: patchZipInPlace,
};

/**
 * Space discipline (staging is reserved byte-for-byte, PRD §4): strategies
 * read from staging and write directly into the storage dir — never a second
 * staging copy. Zip is cleaned by moving first, then patching bytes in place
 * (size never changes). Only the PDF chain briefly holds two copies, both on
 * the storage side.
 */
export class MetadataStripService implements MetadataStripper {
  private readonly strategies: StripStrategies;

  constructor(
    private readonly storage: FileStorage,
    strategies: Partial<StripStrategies> = {},
  ) {
    this.strategies = { ...REAL_STRATEGIES, ...strategies };
  }

  async deliver(input: DeliverInput): Promise<DeliverResult> {
    const support = stripSupportFor(input.fileName);
    const enabled = support.level !== "none" && input.flags[support.toggle];

    if (!enabled) {
      const dest = await this.storage.moveIntoStorage(
        input.stagingPath,
        input.fileId,
        input.fileName,
      );
      // Verbatim delivery. Text/source/config have no metadata channel, so
      // there is genuinely nothing to strip ("none"); anything else that lands
      // here (toggle off, or an uncleanable format) may still carry PII.
      // A file with an unrecognized extension gets the same content sniff the
      // upload page runs — the server never trusts the client's result, it
      // re-derives "is this text?" from the bytes it just received.
      const isText =
        hasNoMetadataChannel(input.fileName) ||
        (shouldSniffForText(input.fileName) && (await sniffFileAsText(dest)));
      return { metadataStatus: isText ? "none" : "possible" };
    }

    if (support.strategy === "zip") {
      const dest = await this.storage.moveIntoStorage(
        input.stagingPath,
        input.fileId,
        input.fileName,
      );
      await this.strategies.zipPatch(dest);
      log.info({ fileId: input.fileId }, "zip container cleaned");
      // Container timestamps/comments cleaned, but the entries inside keep
      // their own metadata — so still "possible", not "stripped".
      return { metadataStatus: "possible" };
    }

    // Full strategies write to a hidden temp in the destination dir, then
    // rename: Caddy serves /f/* straight from disk, so bytes must never be
    // readable at the final path until complete (same rule as
    // FileStorage.copyIntoStorage). The temp keeps the real extension —
    // ffmpeg picks its muxer from it.
    await mkdir(this.storage.dirFor(input.fileId), { recursive: true });
    const ext = extensionOf(input.fileName);
    const temp = path.join(
      this.storage.dirFor(input.fileId),
      `.strip-incoming.${ext}`,
    );
    // A stale temp from a crashed attempt would make exiftool's -o refuse.
    await unlink(temp).catch(() => {});
    try {
      switch (support.strategy) {
        case "image":
          await this.strategies.image(input.stagingPath, temp);
          break;
        case "av":
          await this.strategies.av(
            input.stagingPath,
            temp,
            input.kind === "audio" ? "audio" : "video",
            ext,
          );
          break;
        case "pdf":
          await this.strategies.pdf(input.stagingPath, temp);
          break;
        case "office":
          await this.strategies.office(input.stagingPath, temp, ext);
          break;
      }
      await rename(temp, this.storage.pathFor(input.fileId, input.fileName));
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    // Staging copy is consumed like a move would; the ledger release stays
    // the tus hook's job.
    await unlink(input.stagingPath).catch(() => {});
    log.info(
      { fileId: input.fileId, strategy: support.strategy },
      "metadata stripped",
    );
    return { metadataStatus: "stripped" };
  }
}
