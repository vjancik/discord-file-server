import { z } from "zod";
import { parseBool, parseBytes, parseDuration } from "./units";

const csv = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1));

const bytes = z.string().transform((s, ctx) => {
  try {
    return parseBytes(s);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

const duration = z.string().transform((s, ctx) => {
  try {
    return parseDuration(s);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

const bool = z
  .string()
  .optional()
  .transform((s, ctx) => {
    try {
      return parseBool(s);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message });
      return z.NEVER;
    }
  });

const envSchema = z.object({
  /** Public hostname, e.g. "files.example.com". Used for link generation and Caddy. */
  DOMAIN: z.string().min(1),
  /** Overrides the derived base URL (mainly for local dev: "http://localhost:3000"). */
  BASE_URL: z.url().optional(),
  /** Total bytes the app may use for completed files ("500GB", "2TiB", or raw bytes). */
  STORAGE_LIMIT: bytes,
  /**
   * Total bytes the staging area may hold (in-progress uploads, full declared
   * sizes counted up front). Mandatory: leaving staging unbounded lets N
   * concurrent uploads fill the SSD even though each passes the quota check.
   */
  STAGING_LIMIT: bytes,
  /** Optional global per-file cap; per-file max is otherwise the user's current quota. */
  MAX_FILE_SIZE: bytes.optional(),
  /** Optional default file expiry ("30d", "12h"); unset = files never expire. */
  DEFAULT_FILE_EXPIRY: duration.optional(),
  /** Discord guild IDs whose members may sign in. */
  ALLOWED_GUILD_IDS: csv,
  /** Discord user IDs with admin access. */
  ADMIN_DISCORD_IDS: csv,
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  /**
   * Ask Discord for the user's email at sign-in (adds the `email` OAuth
   * scope). Off by default: the app never uses the email, so users are
   * stored with a placeholder address instead.
   */
  REQUIRE_EMAIL: bool,
  BETTER_AUTH_SECRET: z.string().min(1),
  /** SSD directory for in-progress tus uploads. */
  STAGING_DIR: z.string().min(1),
  /** HDD-array directory for completed files (served by Caddy at /f/*). */
  STORAGE_DIR: z.string().min(1),
  DATABASE_PATH: z.string().min(1),
});

export type Env = z.infer<typeof envSchema> & { baseUrl: string };

let cached: Env | undefined;

/**
 * Validated env access. Parses lazily and memoizes so `next build` (which
 * evaluates module scope during route enumeration without runtime env) does
 * not fail; call sites run at request/boot time. instrumentation.ts calls
 * this in `register()` so a misconfigured deployment fails at startup.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Environment validation failed:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const baseUrl =
    parsed.data.BASE_URL ??
    (process.env.NODE_ENV === "development"
      ? "http://localhost:3000"
      : `https://${parsed.data.DOMAIN}`);
  cached = { ...parsed.data, baseUrl };
  return cached;
}

/** Test-only: reset the memoized env so tests can vary process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
