import { extensionOf } from "./blocked-extensions";

/**
 * Which files the finalize metadata-strip pipeline can clean (PII removal:
 * EXIF GPS, device tags, document authors, archive timestamps). Shared module:
 * the server picks a strip strategy from it and the upload page uses it for
 * the "can't clean this" warning — the two must agree on coverage.
 */

/** Strategy the server runs; doubles as the support level shown to the user. */
export type StripStrategy =
  | "image" // exiftool rewrite minus metadata (orientation + ICC kept)
  | "av" // ffmpeg remux, video and audio alike
  | "pdf" // exiftool -all= then a qpdf rewrite (drops the reversible history)
  | "office" // OOXML/ODF zip rewrite: docProps/meta.xml + comment/revision authors
  | "zip"; // container only: entry timestamps, uid/gid extras, comments

export type StripToggle = "media" | "documents";

export type StripSupport =
  /** Fully cleanable — `metadata_status` becomes "stripped" when the toggle is on. */
  | {
      level: "full";
      strategy: Exclude<StripStrategy, "zip">;
      toggle: StripToggle;
    }
  /** Archive whose container we clean but whose contents we never touch. */
  | { level: "container"; strategy: "zip"; toggle: StripToggle }
  /** Not cleanable. `archive` marks formats whose contents carry metadata too. */
  | { level: "none"; archive: boolean; warn: boolean };

const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "tiff",
  "heic",
  "heif",
  // bmp intentionally absent: exiftool cannot write BMP (and the format has
  // no meaningful metadata channel anyway) — it falls through to "none".
]);

const AV_EXTS = new Set([
  // video (keep in sync with type-policy VIDEO_MIME)
  "mp4",
  "m4v",
  "webm",
  "mov",
  "mkv",
  "avi",
  // audio (keep in sync with type-policy AUDIO_MIME)
  "mp3",
  "wav",
  "ogg",
  "oga",
  "opus",
  "flac",
  "m4a",
  "aac",
]);

const OFFICE_EXTS = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp"]);

/** Archives we cannot clean at all (compressed stream or unsupported format). */
const UNSUPPORTED_ARCHIVE_EXTS = new Set([
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
  "7z",
  "rar",
]);

/**
 * Text-family formats with no embedded-metadata channel: a plain byte stream
 * whose only PII is its own content, which we never edit. Warning about them
 * would be noise, so they're "none" without the banner. Files whose extension
 * isn't listed here fall through to a content sniff (see `looksLikeText`)
 * before the client decides to warn — this list is just the fast path.
 *
 * Executable script extensions (sh/bash/zsh/ps1/bat…) are intentionally absent:
 * they're blocked outright by `blocked-extensions`, so they never reach here.
 */
const NO_METADATA_EXTS = new Set([
  // plain text / docs / logs
  "txt",
  "md",
  "markdown",
  "rst",
  "log",
  "text",
  // data / config
  "csv",
  "tsv",
  "json",
  "jsonc",
  "json5",
  "ndjson",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "config",
  "properties",
  "env",
  "editorconfig",
  "gitignore",
  "gitattributes",
  "dockerfile",
  "lock",
  // web / markup / styles
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  // source code
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "mts",
  "cts",
  "py",
  "pyi",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "php",
  "swift",
  "m",
  "mm",
  "lua",
  "pl",
  "pm",
  "r",
  "jl",
  "dart",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "cljs",
  "sql",
  "graphql",
  "gql",
  "proto",
  "tf",
  "hcl",
  "vue",
  "svelte",
  "asm",
  "s",
]);

/** Upload-page warning summary for a selection of file names. */
export interface StripWarnings {
  /** Files we can't clean at all (and that plausibly carry metadata). */
  unsupported: string[];
  /** Archives — zip included: their contents are never cleaned. */
  archives: string[];
}

/**
 * `sniffedText` holds names the caller has content-sniffed as text (see
 * `looksLikeText`); they're dropped from `unsupported` even when their
 * extension is unrecognized. Archives are never affected by the sniff.
 */
export function summarizeStripWarnings(
  fileNames: string[],
  sniffedText?: ReadonlySet<string>,
): StripWarnings {
  const unsupported: string[] = [];
  const archives: string[] = [];
  for (const name of new Set(fileNames)) {
    const support = stripSupportFor(name);
    if (support.level === "container") archives.push(name);
    else if (support.level === "none" && support.archive) archives.push(name);
    else if (
      support.level === "none" &&
      support.warn &&
      !sniffedText?.has(name)
    )
      unsupported.push(name);
  }
  return { unsupported, archives };
}

/**
 * Whether an unrecognized file is worth content-sniffing before warning:
 * true only for the "none" formats we'd otherwise flag as unsupported (not
 * archives, not the fast-path text extensions). Lets the client sniff the
 * minimum set of files.
 */
export function shouldSniffForText(fileName: string): boolean {
  const support = stripSupportFor(fileName);
  return support.level === "none" && support.warn && !support.archive;
}

/**
 * How many leading bytes `looksLikeText` inspects. A prefix can't prove the
 * whole file is text, but for the narrow purpose here (suppress a cosmetic
 * "can't strip metadata" warning on an unrecognized extension) a wrong guess
 * only mis-shows a heads-up — it never changes what the strip pipeline does,
 * which already delivers text and unknown files verbatim either way.
 */
export const TEXT_SNIFF_BYTES = 8192;

/**
 * Heuristic "is this a text file?" over a byte prefix — the same shape git and
 * file(1) use: no NUL bytes, and control characters limited to the usual
 * whitespace. UTF-8 continuation/lead bytes (≥ 0x80) are allowed so accented
 * text and other scripts pass; this deliberately errs toward calling things
 * text, since the only cost of a false positive is a hidden cosmetic warning.
 *
 * Known blind spots: UTF-16/UTF-32 (NUL-heavy → reads as binary) and a binary
 * blob whose first {@link TEXT_SNIFF_BYTES} happen to be NUL-free (→ reads as
 * text). Neither matters for the warning-only use here.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true; // empty file: nothing to warn about
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) return false; // NUL → binary
    // Reject C0 control chars except tab (0x09), LF (0x0a), CR (0x0d),
    // form-feed (0x0c) and vertical tab (0x0b), all of which appear in text.
    if (b < 0x09 || (b > 0x0d && b < 0x20)) return false;
  }
  return true;
}

/**
 * True for formats we're confident carry no embedded-metadata channel at all
 * (the `NO_METADATA_EXTS` fast path: plain text, source, config). The server
 * records these as `metadata_status = "none"` rather than "possible" — there
 * is nothing to strip, and saying otherwise would be misleading. Decided from
 * the extension only; the upload page's content sniff does not feed into it.
 */
export function hasNoMetadataChannel(fileName: string): boolean {
  return NO_METADATA_EXTS.has(extensionOf(fileName));
}

export function stripSupportFor(fileName: string): StripSupport {
  const ext = extensionOf(fileName);
  if (IMAGE_EXTS.has(ext))
    return { level: "full", strategy: "image", toggle: "media" };
  if (AV_EXTS.has(ext))
    return { level: "full", strategy: "av", toggle: "media" };
  if (ext === "pdf")
    return { level: "full", strategy: "pdf", toggle: "documents" };
  if (OFFICE_EXTS.has(ext))
    return { level: "full", strategy: "office", toggle: "documents" };
  if (ext === "zip")
    return { level: "container", strategy: "zip", toggle: "documents" };
  if (UNSUPPORTED_ARCHIVE_EXTS.has(ext))
    return { level: "none", archive: true, warn: true };
  return { level: "none", archive: false, warn: !NO_METADATA_EXTS.has(ext) };
}
