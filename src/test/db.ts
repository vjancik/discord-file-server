import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { user } from "@/db/auth-schema";
import { createDb, type Db } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import type { NewFileRow } from "@/db/schema";

/** Fresh migrated SQLite database in a temp dir; call cleanup() when done. */
export function createTestDb(): { db: Db; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "upload-server-test-"));
  const db = createDb(path.join(dir, "test.sqlite"));
  runMigrations(db);
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let seq = 0;

export function insertTestUser(db: Db, id = `user-${++seq}`): string {
  db.insert(user)
    .values({
      id,
      name: `Test ${id}`,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
}

export function testFileRow(
  ownerId: string,
  overrides: Partial<NewFileRow> = {},
): NewFileRow {
  const id = crypto.randomUUID().replaceAll("-", "");
  return {
    id,
    ownerId,
    fileName: "clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1000,
    kind: "video",
    shortCode: id.slice(0, 8),
    ...overrides,
  };
}
