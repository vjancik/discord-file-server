import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as authSchema from "./auth-schema";
import * as appSchema from "./schema";

export const schema = { ...appSchema, ...authSchema };

export type Db = ReturnType<typeof createDb>;

/** Standalone factory so tests can run against a temp database file. */
export function createDb(path: string) {
  const sqlite = new Database(path, { create: true });
  // Wait for locks instead of failing with SQLITE_BUSY — concurrent writers
  // are normal (app + hooks), and `next build` page-data workers race each
  // other to run the WAL pragma on a fresh database file.
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return drizzle({ client: sqlite, schema });
}

let cached: Db | undefined;

// Falls back to a throwaway local file so module evaluation survives `next build`
// (route enumeration runs without runtime env); real deployments are validated
// at boot by instrumentation.ts via getEnv().
export function getDb(): Db {
  cached ??= createDb(process.env.DATABASE_PATH ?? "./dev.sqlite");
  return cached;
}
