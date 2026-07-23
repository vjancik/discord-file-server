import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Db } from "@/db/client";
import { createTestDb, insertTestUser } from "@/test/db";
import { SettingsRepository } from "./settings.repository";

let db: Db;
let cleanup: () => void;
let repo: SettingsRepository;
let userId: string;

beforeEach(() => {
  ({ db, cleanup } = createTestDb());
  repo = new SettingsRepository(db);
  userId = insertTestUser(db);
});

afterEach(() => cleanup());

test("returns defaults when no row exists", () => {
  expect(repo.get(userId)).toEqual({
    userId,
    autoDeleteOldest: false,
    skipDeleteConfirm: false,
    // privacy toggles default on — stripping must be opt-out, not opt-in
    stripMediaMetadata: true,
    stripDocumentMetadata: true,
  });
});

test("strip toggles persist when turned off", () => {
  repo.update(userId, { stripMediaMetadata: false });
  const settings = repo.get(userId);
  expect(settings.stripMediaMetadata).toBe(false);
  expect(settings.stripDocumentMetadata).toBe(true);
});

test("update creates the row on first write and patches on later writes", () => {
  repo.update(userId, { autoDeleteOldest: true });
  expect(repo.get(userId).autoDeleteOldest).toBe(true);
  expect(repo.get(userId).skipDeleteConfirm).toBe(false);

  repo.update(userId, { skipDeleteConfirm: true });
  const settings = repo.get(userId);
  expect(settings.autoDeleteOldest).toBe(true);
  expect(settings.skipDeleteConfirm).toBe(true);
});
