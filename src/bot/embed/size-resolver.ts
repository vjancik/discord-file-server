import { createLogger } from "@/lib/logger";
import { isEmbedRelevant, type ProbeFormat, type ProbeInfo } from "./selection";

const log = createLogger("bot:embed:sizes");

/**
 * Fills in exact `filesize` for direct-URL formats the probe left unsized
 * (docs/embed-video.md, "size lookups"). Instagram is the motivating case: no
 * filesize, no filesize_approx and no duration, so no estimate is possible —
 * yet every DASH representation is a plain https file whose Content-Length is
 * one HEAD away.
 *
 * Best-effort by contract: never throws, and any format it can't size within
 * the time budget is returned untouched (selection then treats it as unknown,
 * exactly as before).
 */
export interface SizeResolver {
  resolve(info: ProbeInfo, signal?: AbortSignal): Promise<ProbeInfo>;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type HttpSizeResolverOpts = {
  fetch?: FetchFn;
  /** Budget for all lookups of one probe together. */
  timeoutMs?: number;
  concurrency?: number;
  /** Cap on lookups per probe; the rest stay unknown. */
  maxLookups?: number;
};

/** Manifest protocols (m3u8, http_dash_segments, …) have no single file. */
const DIRECT_PROTOCOLS = new Set(["http", "https"]);

const positive = (n: number | null | undefined) =>
  typeof n === "number" && n > 0;

export function needsLookup(
  f: ProbeFormat,
): f is ProbeFormat & { url: string } {
  return (
    typeof f.url === "string" &&
    /^https?:\/\//i.test(f.url) &&
    DIRECT_PROTOCOLS.has(f.protocol ?? "") &&
    !positive(f.filesize) &&
    !positive(f.filesize_approx) &&
    isEmbedRelevant(f)
  );
}

const toSize = (raw: string | null | undefined): number | null => {
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Exact byte size from a HEAD or `Range: bytes=0-0` response, or null.
 * 206 → total from Content-Range; 200 → Content-Length (a ranged GET the
 * server answered in full counts too). A content-encoded length is the
 * compressed size, not the file's, so it's ignored.
 */
export function sizeFromResponse(res: Response): number | null {
  if (res.status === 206) {
    const m = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(
      res.headers.get("content-range")?.trim() ?? "",
    );
    return toSize(m?.[1]);
  }
  if (res.status !== 200) return null;
  const encoding = res.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return null;
  return toSize(res.headers.get("content-length"));
}

export class HttpSizeResolver implements SizeResolver {
  private readonly fetch: FetchFn;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly maxLookups: number;

  constructor(opts: HttpSizeResolverOpts = {}) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.maxLookups = opts.maxLookups ?? 32;
  }

  async resolve(info: ProbeInfo, signal?: AbortSignal): Promise<ProbeInfo> {
    const targets = (info.formats ?? [])
      .filter(needsLookup)
      .slice(0, this.maxLookups);
    if (targets.length === 0) return info;

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const started = Date.now();
    const sizes = new Map<string, number>();

    const queue = [...targets];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        if (combined.aborted) return;
        const size = await this.lookup(f, combined);
        if (size !== null) sizes.set(f.format_id, size);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, targets.length) }, () =>
        worker(),
      ),
    );

    log.info(
      {
        resolved: sizes.size,
        lookups: targets.length,
        ms: Date.now() - started,
        timedOut: deadline.aborted,
      },
      "format size lookups done",
    );
    if (sizes.size === 0) return info;
    return {
      ...info,
      formats: info.formats?.map((f) => {
        const size = sizes.get(f.format_id);
        return size === undefined ? f : { ...f, filesize: size };
      }),
    };
  }

  /** HEAD first; servers that refuse it or omit the length get a 1-byte GET. */
  private async lookup(
    f: ProbeFormat & { url: string },
    signal: AbortSignal,
  ): Promise<number | null> {
    const headers = { ...(f.http_headers ?? {}) };
    try {
      const head = await this.fetch(f.url, { method: "HEAD", headers, signal });
      const size = sizeFromResponse(head);
      if (size !== null) return size;
    } catch (err) {
      if (signal.aborted) return null;
      log.debug({ err, formatId: f.format_id }, "HEAD size lookup failed");
    }
    try {
      const res = await this.fetch(f.url, {
        method: "GET",
        headers: { ...headers, Range: "bytes=0-0" },
        signal,
      });
      // Never read the body: a server ignoring Range would stream the file.
      await res.body?.cancel().catch(() => {});
      return sizeFromResponse(res);
    } catch (err) {
      if (!signal.aborted)
        log.debug({ err, formatId: f.format_id }, "ranged size lookup failed");
      return null;
    }
  }
}
