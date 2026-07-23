import { formatBytes } from "@/lib/units";

/**
 * Format selection for /embed_video (docs/embed-video.md). Everything here is
 * pure logic over the yt-dlp `-J` probe JSON: yt-dlp's own `-f` filters can't
 * constrain the *sum* of a video+audio pair and silently drop formats with
 * unknown sizes, so we pick explicit format ids ourselves.
 */

/** Subset of a yt-dlp `-J` format entry we consume. */
export type ProbeFormat = {
  format_id: string;
  ext?: string | null;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  /** Total bitrate in kbit/s; peak (not average) for manifest formats. */
  tbr?: number | null;
  protocol?: string | null;
};

/** Subset of the yt-dlp `-J` top-level info we consume. */
export type ProbeInfo = {
  id?: string;
  title?: string;
  description?: string | null;
  /** Canonical page URL as resolved by the extractor. */
  webpage_url?: string;
  view_count?: number | null;
  /** Publish time, epoch seconds; more precise than upload_date when present. */
  timestamp?: number | null;
  /** Publish date as YYYYMMDD. */
  upload_date?: string | null;
  duration?: number | null;
  is_live?: boolean | null;
  _type?: string;
  entries?: unknown[];
  formats?: ProbeFormat[];
  /** Single fallback thumbnail URL some extractors provide instead of a list. */
  thumbnail?: string | null;
  /** Candidate thumbnails, richest source of poster art (docs/embed-video.md). */
  thumbnails?: ProbeThumbnail[];
};

/** Subset of a yt-dlp `-J` thumbnail entry we consume. */
export type ProbeThumbnail = {
  url?: string | null;
  width?: number | null;
  height?: number | null;
  /** yt-dlp's own ranking; higher is better. */
  preference?: number | null;
};

/** exact > approx > rough; "unknown" means no basis for a number at all. */
export type SizeConfidence = "exact" | "approx" | "rough";
export type SizeEstimate =
  | { confidence: SizeConfidence; bytes: number }
  | { confidence: "unknown" };

/** One downloadable choice: a single complete format or a video+audio pair. */
export type Candidate = {
  formatIds: string[];
  /** Merge container passed to yt-dlp; null for single complete formats. */
  mergeFormat: "mp4" | "webm" | null;
  height: number;
  estimate: SizeEstimate;
  /** e.g. "720p · ~340 MB" or "1080p · size unknown" */
  label: string;
};

export type EmbedPlan =
  | { kind: "reject"; reason: string }
  | { kind: "fits"; best: Candidate }
  | { kind: "unknown"; best: Candidate }
  | { kind: "choose"; best: Candidate; fit?: Candidate };

/** Safety margins: estimates can undershoot; mux overhead measured ~0.3%. */
const EXACT_MARGIN = 1.02;
const ESTIMATE_MARGIN = 1.05;

const EMBED_CONTAINERS = new Set(["mp4", "webm", "m4a", "mov"]);

function sizeOf(fmt: ProbeFormat, duration: number | null): SizeEstimate {
  if (typeof fmt.filesize === "number" && fmt.filesize > 0)
    return { confidence: "exact", bytes: fmt.filesize };
  if (typeof fmt.filesize_approx === "number" && fmt.filesize_approx > 0)
    return { confidence: "approx", bytes: fmt.filesize_approx };
  // Manifest formats: yt-dlp abstains because tbr may be a peak rate — we
  // still surface it, clearly labeled rough (docs/embed-video.md).
  if (typeof fmt.tbr === "number" && fmt.tbr > 0 && duration)
    return { confidence: "rough", bytes: (fmt.tbr * 1000 * duration) / 8 };
  return { confidence: "unknown" };
}

const worse = (a: SizeConfidence, b: SizeConfidence): SizeConfidence => {
  const order: SizeConfidence[] = ["exact", "approx", "rough"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
};

function combine(a: SizeEstimate, b: SizeEstimate): SizeEstimate {
  if (a.confidence === "unknown" || b.confidence === "unknown")
    return { confidence: "unknown" };
  return {
    confidence: worse(a.confidence, b.confidence),
    bytes: a.bytes + b.bytes,
  };
}

export function fitsLimit(estimate: SizeEstimate, limit: number): boolean {
  if (estimate.confidence === "unknown") return false;
  const margin =
    estimate.confidence === "exact" ? EXACT_MARGIN : ESTIMATE_MARGIN;
  return estimate.bytes * margin <= limit;
}

const isAudioOnly = (f: ProbeFormat) => f.vcodec === "none";
const hasVideo = (f: ProbeFormat) =>
  f.vcodec != null ? f.vcodec !== "none" : true;
/**
 * Complete = playable alone. Explicit acodec, or (like Vimeo progressive)
 * codecs unreported entirely on a video-container format — treated as
 * containing both streams.
 */
const isComplete = (f: ProbeFormat) =>
  hasVideo(f) && (f.acodec != null ? f.acodec !== "none" : f.vcodec == null);

const isVideoOnly = (f: ProbeFormat) =>
  f.vcodec != null && f.vcodec !== "none" && f.acodec === "none";

/** mp4-family video pairs with m4a/mp4 audio; webm with webm. */
function audioFamily(videoExt: string | null | undefined): string[] {
  return videoExt === "webm" ? ["webm"] : ["m4a", "mp4"];
}

function label(height: number, estimate: SizeEstimate): string {
  const res = height > 0 ? `${height}p` : "audio/video";
  if (estimate.confidence === "unknown") return `${res} · size unknown`;
  const approx = estimate.confidence === "exact" ? "" : "~";
  const rough = estimate.confidence === "rough" ? " (rough)" : "";
  return `${res} · ${approx}${formatBytes(estimate.bytes)}${rough}`;
}

/**
 * All viable candidates, best first. Sort: height desc, then known size
 * before unknown (prefer the sized sibling at equal quality), then larger
 * estimated size (higher bitrate) first.
 */
export function buildCandidates(info: ProbeInfo): Candidate[] {
  const duration = info.duration ?? null;
  const formats = (info.formats ?? []).filter(
    (f) => !f.ext || EMBED_CONTAINERS.has(f.ext) || isAudioOnly(f),
  );

  const completes = formats.filter(
    (f) => isComplete(f) && (!f.ext || f.ext === "mp4" || f.ext === "webm"),
  );
  const videos = formats.filter(isVideoOnly);
  const audios = formats.filter(isAudioOnly);

  const bestAudioFor = (videoExt: string | null | undefined) => {
    const family = audioFamily(videoExt);
    const pool = audios.filter((a) => a.ext != null && family.includes(a.ext));
    return pool.reduce<ProbeFormat | undefined>((best, a) => {
      if (!best) return a;
      const bytes = (f: ProbeFormat) => {
        const s = sizeOf(f, duration);
        return s.confidence === "unknown" ? -1 : s.bytes;
      };
      return bytes(a) > bytes(best) ? a : best;
    }, undefined);
  };

  const candidates: Candidate[] = [];
  for (const f of completes) {
    const estimate = sizeOf(f, duration);
    candidates.push({
      formatIds: [f.format_id],
      mergeFormat: null,
      height: f.height ?? 0,
      estimate,
      label: label(f.height ?? 0, estimate),
    });
  }
  for (const v of videos) {
    const audio = bestAudioFor(v.ext);
    if (!audio) continue;
    const estimate = combine(sizeOf(v, duration), sizeOf(audio, duration));
    candidates.push({
      formatIds: [v.format_id, audio.format_id],
      mergeFormat: v.ext === "webm" ? "webm" : "mp4",
      height: v.height ?? 0,
      estimate,
      label: label(v.height ?? 0, estimate),
    });
  }

  const rank = { exact: 3, approx: 2, rough: 1, unknown: 0 } as const;
  return candidates.sort((a, b) => {
    if (a.height !== b.height) return b.height - a.height;
    if (a.estimate.confidence !== b.estimate.confidence)
      return rank[b.estimate.confidence] - rank[a.estimate.confidence];
    const bytes = (c: Candidate) =>
      c.estimate.confidence === "unknown" ? 0 : c.estimate.bytes;
    return bytes(b) - bytes(a);
  });
}

/**
 * Best source thumbnail URL, or null. Social sources often ship a far better
 * poster than an ffmpeg frame-grab, so we reuse it when the server can fetch
 * it (finalize downscales + falls back to the ffmpeg frame on any failure).
 *
 * "Best reasonably sized": prefer yt-dlp's own `preference`, then the largest
 * thumbnail whose width stays under a sane cap (huge originals just cost
 * bandwidth — finalize scales everything to ≤640px anyway), then any URL.
 */
const THUMB_MAX_WIDTH = 2048;

export function pickThumbnail(info: ProbeInfo): string | null {
  const withUrl = (info.thumbnails ?? []).filter(
    (t): t is ProbeThumbnail & { url: string } =>
      typeof t.url === "string" && /^https?:\/\//i.test(t.url),
  );
  if (withUrl.length > 0) {
    const score = (t: ProbeThumbnail & { url: string }) => {
      const pref = typeof t.preference === "number" ? t.preference : 0;
      const width = typeof t.width === "number" && t.width > 0 ? t.width : 0;
      // Oversized posters lose to anything within the cap, but a too-big
      // thumbnail still beats no width info at all.
      const sized = width > 0 && width <= THUMB_MAX_WIDTH ? width : -1;
      return { pref, sized, width };
    };
    const best = withUrl.reduce((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sa.pref !== sb.pref) return sa.pref > sb.pref ? a : b;
      if (sa.sized !== sb.sized) return sa.sized > sb.sized ? a : b;
      return sa.width >= sb.width ? a : b;
    });
    return best.url;
  }
  return typeof info.thumbnail === "string" &&
    /^https?:\/\//i.test(info.thumbnail)
    ? info.thumbnail
    : null;
}

export function planEmbed(info: ProbeInfo, embedLimit: number): EmbedPlan {
  if (info._type === "playlist" || (info.entries?.length ?? 0) > 0)
    return {
      kind: "reject",
      reason: "Playlists aren't supported — pass a single video.",
    };
  if (info.is_live)
    return { kind: "reject", reason: "Livestreams aren't supported." };

  const candidates = buildCandidates(info);
  const best = candidates[0];
  if (!best)
    return { kind: "reject", reason: "No downloadable video formats found." };

  if (best.estimate.confidence === "unknown") return { kind: "unknown", best };
  if (fitsLimit(best.estimate, embedLimit)) return { kind: "fits", best };

  // Highest-quality candidate that fits the embed limit, if any.
  const fit = candidates.find((c) => fitsLimit(c.estimate, embedLimit));
  return { kind: "choose", best, fit };
}
