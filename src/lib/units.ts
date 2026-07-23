const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000 ** 1,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024 ** 1,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/**
 * Parse a byte size from an env var: either a plain integer ("1073741824")
 * or a number with a unit suffix ("500GB", "1.5 TiB", case-insensitive).
 */
export function parseBytes(input: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(input);
  if (!match) throw new Error(`Invalid byte size: "${input}"`);
  const [, num, rawUnit] = match;
  const unit = rawUnit.toLowerCase() || "b";
  const factor = BYTE_UNITS[unit];
  if (factor === undefined)
    throw new Error(`Unknown byte unit "${rawUnit}" in "${input}"`);
  const value = Number(num) * factor;
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`Invalid byte size: "${input}"`);
  return Math.floor(value);
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * Parse a duration from an env var into milliseconds: "30d", "12h", "90m", "1w".
 * A plain integer is interpreted as seconds.
 */
export function parseDuration(input: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]?)\s*$/i.exec(input);
  if (!match) throw new Error(`Invalid duration: "${input}"`);
  const [, num, rawUnit] = match;
  const unit = rawUnit.toLowerCase() || "s";
  const factor = DURATION_UNITS[unit];
  if (factor === undefined)
    throw new Error(`Unknown duration unit "${rawUnit}" in "${input}"`);
  const value = Number(num) * factor;
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`Invalid duration: "${input}"`);
  return Math.floor(value);
}

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off", ""]);

/**
 * Parse a boolean from an env var: true/1/yes/on and false/0/no/off,
 * case-insensitive. Unset or empty means false.
 */
export function parseBool(input: string | undefined): boolean {
  const word = (input ?? "").trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  throw new Error(`Invalid boolean: "${input}"`);
}

/** Human-readable byte size for UI and OG descriptions (decimal units, 1 decimal place). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1000) break;
    value /= 1000;
    unit = next;
  }
  const rounded =
    value >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return `${rounded} ${unit}`;
}
