/**
 * yt-dlp failure output → a single safe Discord message chunk. We can't
 * enumerate yt-dlp's errors, so the contract is sanitize-and-passthrough:
 * ANSI stripped, URLs wrapped in <> (suppresses unfurls), truncated to fit
 * Discord's 2,000-char content limit with room for our framing.
 */

const MAX_ERROR_CHARS = 1_800;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL = /(https?:\/\/[^\s<>]+)/g;

/** Friendlier one-liners for recognizable failure classes. */
const KNOWN: [RegExp, string][] = [
  [/Unsupported URL/i, "That site isn't supported by yt-dlp."],
  [
    /not available in your country|geo.?restricted/i,
    "This video is geo-restricted from the server's location.",
  ],
  [
    /sign in|login required|private video|members-only/i,
    "This video requires a login or is private.",
  ],
  [/live event|is a live|live stream/i, "Livestreams aren't supported."],
  [
    /No space left on device/i,
    "The server ran out of scratch space — try again later.",
  ],
];

export function sanitizeYtDlpError(stderr: string): string {
  const clean = stderr.replace(ANSI, "");
  for (const [pattern, message] of KNOWN) {
    if (pattern.test(clean)) return message;
  }

  const lines = clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errors = lines.filter((l) => l.startsWith("ERROR:"));
  const tail = (errors.length > 0 ? errors : lines).slice(-5).join("\n");
  const wrapped = (tail || "yt-dlp failed with no output.").replace(
    URL,
    "<$1>",
  );
  return wrapped.length <= MAX_ERROR_CHARS
    ? wrapped
    : `${wrapped.slice(0, MAX_ERROR_CHARS)}…`;
}
