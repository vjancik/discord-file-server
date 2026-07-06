import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { FileRow } from "@/db/schema";
import { createLogger } from "@/lib/logger";
import { generateFileId, generateShortCode } from "../links/ids";
import type { MediaProber } from "../media/prober";
import type { FileRepository } from "./file.repository";
import type { FileStorage } from "./storage";
import { classifyUpload, sniffExecutable } from "./type-policy";

export class UploadRejectedError extends Error {}

export interface FinalizeInput {
  /** Completed tus upload in the staging dir. */
  stagingPath: string;
  ownerId: string;
  rawFileName: string;
  clientMime?: string;
  sizeBytes: number;
}

const log = createLogger("finalize");

/**
 * Turns a completed staging upload into a published file: byte-level executable
 * check, ffprobe metadata, thumbnail, move to the HDD array, DB row (status
 * `pending` — live immediately, PRD §6), auto-generated short code.
 */
export class FinalizeService {
  constructor(
    private readonly repo: FileRepository,
    private readonly storage: FileStorage,
    private readonly prober: MediaProber,
    private readonly opts: { defaultExpiryMs?: number } = {},
  ) {}

  async finalize(input: FinalizeInput): Promise<FileRow> {
    const classified = classifyUpload(input.rawFileName, input.clientMime);
    if (!classified.ok) throw new UploadRejectedError(classified.reason);
    const { kind, mimeType, fileName } = classified;

    const head = await this.storage.readHead(input.stagingPath);
    if (await sniffExecutable(head)) {
      throw new UploadRejectedError("Executable files are not allowed.");
    }

    const fileId = generateFileId();
    const info =
      kind === "other" ? {} : await this.prober.probe(input.stagingPath);

    // Thumbnail is rendered from the staging copy (SSD) into the storage dir,
    // then the file itself is moved (rename, or copy+unlink across devices).
    let thumbnailPath: string | null = null;

    try {
      await mkdir(this.storage.dirFor(fileId), { recursive: true });
      if (kind === "video" || kind === "image") {
        const thumbDest = this.storage.pathFor(fileId, "thumb.jpg");
        const made = await this.prober.makeThumbnail(
          input.stagingPath,
          thumbDest,
          kind,
          info,
        );
        thumbnailPath = made ? path.posix.join(fileId, "thumb.jpg") : null;
      }
      await this.storage.moveIntoStorage(input.stagingPath, fileId, fileName);

      const row = this.repo.insert({
        id: fileId,
        ownerId: input.ownerId,
        fileName,
        mimeType,
        sizeBytes: input.sizeBytes,
        kind,
        shortCode: generateShortCode(),
        width: info.width ?? null,
        height: info.height ?? null,
        durationSeconds: info.durationSeconds ?? null,
        thumbnailPath,
        expiresAt: this.opts.defaultExpiryMs
          ? new Date(Date.now() + this.opts.defaultExpiryMs)
          : null,
      });
      log.info(
        { fileId, kind, sizeBytes: input.sizeBytes, ownerId: input.ownerId },
        "file published",
      );
      return row;
    } catch (err) {
      // Roll back any bytes already placed in storage; staging cleanup is the caller's job.
      await this.storage.removeFileDir(fileId);
      throw err;
    }
  }
}
