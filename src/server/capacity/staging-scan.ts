import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@/lib/logger";
import type { StagingLedger } from "./staging-ledger";

const log = createLogger("staging-scan");

/** A tus upload present in the staging dir: `<id>` data file + `<id>.json` sidecar. */
export interface ScannedUpload {
  id: string;
  /** Declared full size from the sidecar (0 when absent/deferred). */
  sizeBytes: number;
  /** Stamped into metadata by onUploadCreate; absent on pre-upgrade leftovers. */
  ownerId?: string;
  /** Bytes of the (possibly partial) data file currently on disk. */
  bytesOnDisk: number;
  /** Newest mtime of the pair. The data file is written on every chunk, so this is the activity signal. */
  mtimeMs: number;
  dataPath: string;
  sidecarPath: string;
}

/** A staging entry that no live upload can ever complete (see classification below). */
export interface OrphanEntry {
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface StagingScan {
  uploads: ScannedUpload[];
  /**
   * Orphans: data files without a sidecar (finalize failed after the sidecar
   * was unlinked, or a crash mid-cleanup) and sidecars without a data file.
   * Neither can be resumed by tus (`getUpload` requires both), so they are
   * dead bytes until GC — and the first thing pressure eviction removes.
   */
  orphans: OrphanEntry[];
  orphanBytes: number;
  /** Total data bytes staging currently occupies (uploads + orphans). */
  bytesOnDisk: number;
}

interface SidecarShape {
  size?: number;
  metadata?: { ownerId?: string };
}

/**
 * One consistent snapshot of the staging dir, pairing FileStore data files
 * with their `<id>.json` sidecars. Entries that vanish mid-scan (raced by an
 * active upload, GC, or finalize) are skipped; a sidecar that fails to parse
 * is skipped entirely rather than misclassified as an orphan, since it may be
 * mid-write by a concurrent create.
 */
export async function scanStaging(stagingDir: string): Promise<StagingScan> {
  let entries: string[];
  try {
    entries = await readdir(stagingDir);
  } catch (err) {
    log.warn({ err, stagingDir }, "staging dir not readable");
    return { uploads: [], orphans: [], orphanBytes: 0, bytesOnDisk: 0 };
  }

  const names = new Set(entries);
  const uploads: ScannedUpload[] = [];
  const orphans: OrphanEntry[] = [];

  for (const entry of entries) {
    const filePath = path.join(stagingDir, entry);
    if (entry.endsWith(".json")) {
      const id = entry.slice(0, -".json".length);
      if (names.has(id)) continue; // handled with its data file below
      const info = await statSafe(filePath);
      if (info) {
        orphans.push({
          filePath,
          sizeBytes: info.size,
          mtimeMs: info.mtimeMs,
        });
      }
      continue;
    }

    const dataInfo = await statSafe(filePath);
    if (!dataInfo?.isFile()) continue;

    const sidecarPath = `${filePath}.json`;
    if (!names.has(`${entry}.json`)) {
      orphans.push({
        filePath,
        sizeBytes: dataInfo.size,
        mtimeMs: dataInfo.mtimeMs,
      });
      continue;
    }

    const sidecar = await readSidecar(sidecarPath);
    if (!sidecar) continue; // unreadable/mid-write — skip this pass
    const sidecarInfo = await statSafe(sidecarPath);
    uploads.push({
      id: entry,
      sizeBytes: sidecar.size ?? 0,
      ownerId: sidecar.metadata?.ownerId,
      bytesOnDisk: dataInfo.size,
      mtimeMs: Math.max(dataInfo.mtimeMs, sidecarInfo?.mtimeMs ?? 0),
      dataPath: filePath,
      sidecarPath,
    });
  }

  const orphanBytes = orphans.reduce((sum, o) => sum + o.sizeBytes, 0);
  const bytesOnDisk =
    orphanBytes + uploads.reduce((sum, u) => sum + u.bytesOnDisk, 0);
  return { uploads, orphans, orphanBytes, bytesOnDisk };
}

/**
 * Boot-time ledger reconstruction. Resumed uploads PATCH an existing URL and
 * never re-enter onUploadCreate, so after a restart the sidecars are the only
 * record of in-flight reservations.
 */
export function rebuildLedger(
  scan: StagingScan,
  ledger: StagingLedger,
): number {
  ledger.clear();
  for (const upload of scan.uploads) {
    ledger.reserve(upload.id, upload.sizeBytes, upload.ownerId ?? "unknown");
  }
  return scan.uploads.length;
}

/**
 * Periodic self-healing: releases reservations whose staging files are gone
 * (a missed release path) and re-adds uploads present on disk but missing
 * from the ledger. Keeps ledger drift bounded to one interval instead of
 * requiring every release path to be perfect forever.
 */
export function reconcileLedger(
  scan: StagingScan,
  ledger: StagingLedger,
): { added: number; released: number } {
  const onDisk = new Set(scan.uploads.map((u) => u.id));
  let released = 0;
  for (const id of ledger.ids()) {
    if (!onDisk.has(id) && ledger.release(id)) released++;
  }
  let added = 0;
  for (const upload of scan.uploads) {
    if (!ledger.has(upload.id)) {
      ledger.reserve(upload.id, upload.sizeBytes, upload.ownerId ?? "unknown");
      added++;
    }
  }
  return { added, released };
}

async function statSafe(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return undefined; // raced with deletion
  }
}

async function readSidecar(
  filePath: string,
): Promise<SidecarShape | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as SidecarShape;
  } catch {
    return undefined;
  }
}
