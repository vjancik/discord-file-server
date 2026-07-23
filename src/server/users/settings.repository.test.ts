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
  });
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
