import { statSync } from "node:fs";
// Bun's native fetch explicitly: the test preload registers happy-dom, whose
// patched global fetch can't stream Bun.file bodies.
import { fetch } from "bun";
import { createLogger } from "@/lib/logger";

const log = createLogger("bot:tus");

/** JSON body the server's onUploadFinish hook returns on the final PATCH. */
export type TusUploadResult = {
  fileId: string;
  fileName: string;
  kind: string;
  shortUrl: string;
  canonicalUrl: string;
};

export class TusUploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export class UploadCancelledError extends Error {}

export type TusUploadOptions = {
  /** e.g. `${baseUrl}/api/upload` */
  endpoint: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  /**
   * Source-provided poster URL (e.g. a social thumbnail). Passed as tus
   * metadata so the server can prefer it over an ffmpeg frame-grab.
   */
  sourceThumbnailUrl?: string;
  /** Fresh service token per attempt — re-minted so 429 waits can outlive exp. */
  token: () => string;
  /** Called when staging admission says wait (429), with the server's reason. */
  onQueued?: (reason: string) => void;
  signal?: AbortSignal;
  /** Delay between 429 retries. */
  waitDelayMs?: number;
  /** Give up waiting for staging space after this long. */
  maxWaitMs?: number;
};

const enc = (s: string) => Buffer.from(s, "utf8").toString("base64");
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new UploadCancelledError("Cancelled."));
      },
      { once: true },
    );
  });

/**
 * Minimal tus client for the bot's local-network upload (docs/embed-video.md
 * phase 5). Deliberately not tus-js-client: we need only create + PATCH with
 * resume-on-retry, and first-class handling of the server's 429 staging wait
 * (the same no-FIFO queue web uploads sit in).
 */
export async function tusUpload(
  opts: TusUploadOptions,
): Promise<TusUploadResult> {
  const size = statSync(opts.filePath).size;
  const waitDelay = opts.waitDelayMs ?? 5_000;
  const deadline = Date.now() + (opts.maxWaitMs ?? 10 * 60_000);

  const headers = (extra: Record<string, string> = {}) => ({
    "Tus-Resumable": "1.0.0",
    "x-service-token": opts.token(),
    ...extra,
  });
  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new UploadCancelledError("Cancelled.");
  };

  // Create — retrying while staging admission asks us to wait.
  let location: string;
  for (;;) {
    throwIfAborted();
    const res = await fetch(opts.endpoint, {
      method: "POST",
      headers: headers({
        "Upload-Length": String(size),
        "Upload-Metadata": [
          `filename ${enc(opts.fileName)}`,
          `filetype ${enc(opts.mimeType)}`,
          ...(opts.sourceThumbnailUrl
            ? [`sourcethumbnail ${enc(opts.sourceThumbnailUrl)}`]
            : []),
        ].join(","),
      }),
      signal: opts.signal,
    });
    if (res.status === 201) {
      const loc = res.headers.get("location");
      if (!loc) throw new TusUploadError("tus server returned no Location.");
      // The server mints Location from its public base URL; keep talking over
      // the endpoint we were given (internal Docker network, not the edge).
      location = new URL(
        new URL(loc, opts.endpoint).pathname,
        opts.endpoint,
      ).toString();
      break;
    }
    const body = await res.text();
    if (res.status === 429) {
      if (Date.now() >= deadline)
        throw new TusUploadError(
          `Gave up waiting for staging space: ${body}`,
          429,
        );
      opts.onQueued?.(body);
      await sleep(waitDelay, opts.signal);
      continue;
    }
    throw new TusUploadError(
      body || `Upload rejected (${res.status}).`,
      res.status,
    );
  }

  // PATCH the bytes; on transient failure, resume from the server's offset.
  for (let attempt = 0; ; attempt++) {
    throwIfAborted();
    const offset = attempt === 0 ? 0 : await currentOffset(location, headers());
    if (offset < size || attempt === 0) {
      const res = await fetch(location, {
        method: "PATCH",
        headers: headers({
          "Content-Type": "application/offset+octet-stream",
          "Upload-Offset": String(offset),
        }),
        body: Bun.file(opts.filePath).slice(offset),
        signal: opts.signal,
      });
      if (res.ok) {
        const text = await res.text();
        try {
          return JSON.parse(text) as TusUploadResult;
        } catch {
          throw new TusUploadError(
            "Upload finished but finalize returned no result.",
          );
        }
      }
      const body = await res.text();
      // Finalize-level rejections (type policy etc.) are final, not transient.
      if (res.status >= 400 && res.status < 500)
        throw new TusUploadError(
          body || `Upload failed (${res.status}).`,
          res.status,
        );
      if (attempt >= 2)
        throw new TusUploadError(
          body || `Upload failed (${res.status}).`,
          res.status,
        );
      log.warn({ status: res.status, attempt }, "PATCH failed; resuming");
      await sleep(1_000, opts.signal);
    }
  }
}

async function currentOffset(
  location: string,
  headers: Record<string, string>,
): Promise<number> {
  const res = await fetch(location, { method: "HEAD", headers });
  const offset = Number(res.headers.get("upload-offset"));
  if (!res.ok || !Number.isFinite(offset))
    throw new TusUploadError(
      `Lost the upload (HEAD ${res.status}).`,
      res.status,
    );
  return offset;
}
