// Seed a test file into the dev DB + storage dir (run from project root: bun seed-file.ts)
import { mkdirSync } from "node:fs";
import path from "node:path";
import { user } from "@/db/auth-schema";
import { getDb } from "@/db/client";
import { FileRepository } from "@/server/files/file.repository";
import { generateFileId, generateShortCode } from "@/server/links/ids";

const db = getDb();
const repo = new FileRepository(db);

const userId = "smoke-test-user";
db.insert(user)
  .values({
    id: userId,
    name: "Smoke Tester",
    email: "smoke@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  .onConflictDoNothing()
  .run();

const id = generateFileId();
const storageDir = process.env.STORAGE_DIR ?? "./.data/uploads";
mkdirSync(path.join(storageDir, id), { recursive: true });
// 1x1 black JPEG-ish payload: content doesn't matter for the routing smoke test
await Bun.write(
  path.join(storageDir, id, "demo video.mp4"),
  "not-really-mp4-bytes",
);
await Bun.write(path.join(storageDir, id, "thumb.jpg"), "not-really-jpeg");

const row = repo.insert({
  id,
  ownerId: userId,
  fileName: "demo video.mp4",
  mimeType: "video/mp4",
  sizeBytes: 20,
  kind: "video",
  shortCode: generateShortCode(),
  width: 1280,
  height: 720,
  durationSeconds: 12,
  thumbnailPath: `${id}/thumb.jpg`,
});

console.log(JSON.stringify({ id: row.id, shortCode: row.shortCode }));
