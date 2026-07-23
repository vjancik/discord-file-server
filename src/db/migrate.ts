import path from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { Db } from "./client";

/**
 * Applies all pending migrations. Called from instrumentation.ts at boot and
 * from integration tests against temp databases. MIGRATIONS_DIR overrides the
 * default for the standalone Docker build, where the folder is copied next to
 * server.js rather than living under src/.
 */
export function runMigrations(db: Db): void {
  const folder =
    process.env.MIGRATIONS_DIR ??
    path.resolve(process.cwd(), "src/db/migrations");
  migrate(db, { migrationsFolder: folder });
}
