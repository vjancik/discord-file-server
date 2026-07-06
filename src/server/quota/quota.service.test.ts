import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "@/db/client";
import { createTestDb, insertTestUser, testFileRow } from "@/test/db";
import { FileRepository } from "../files/file.repository";
import { QuotaService } from "./quota.service";

let db: Db;
let cleanup: () => void;
let repo: FileRepository;
let alice: string;
let bob: string;
let carol: string;

beforeEach(() => {
  ({ db, cleanup } = createTestDb());
  repo = new FileRepository(db);
  alice = insertTestUser(db);
  bob = insertTestUser(db);
  carol = insertTestUser(db);
});

afterEach(() => cleanup());

const service = (storageLimit: number, maxFileSize?: number) =>
  new QuotaService(repo, { storageLimit, maxFileSize });

describe("quotaFor (divisor edge cases)", () => {
  test("sole prospective user gets the whole limit", () => {
    expect(service(1000).quotaFor(alice)).toBe(1000);
  });

  test("a first-time uploader is counted into the divisor", () => {
    repo.insert(testFileRow(bob, { sizeBytes: 10 }));
    repo.insert(testFileRow(carol, { sizeBytes: 10 }));
    // alice holds nothing yet: divisor = 2 active + her = 3
    expect(service(900).quotaFor(alice)).toBe(300);
  });

  test("an active user is not double-counted", () => {
    repo.insert(testFileRow(alice, { sizeBytes: 10 }));
    repo.insert(testFileRow(bob, { sizeBytes: 10 }));
    expect(service(900).quotaFor(alice)).toBe(450);
  });

  test("tombstoned files do not keep a user active", () => {
    const row = repo.insert(testFileRow(bob, { sizeBytes: 10 }));
    repo.markDeleted(row.id, bob);
    expect(service(1000).quotaFor(alice)).toBe(1000);
  });
});

describe("planUpload", () => {
  test("accepts an upload that fits", () => {
    repo.insert(testFileRow(alice, { sizeBytes: 100 }));
    expect(service(1000).planUpload(alice, 500, false)).toEqual({
      action: "accept",
      toDelete: [],
    });
  });

  test("rejects a file above MAX_FILE_SIZE even when quota would allow it", () => {
    const plan = service(1000, 200).planUpload(alice, 300, false);
    expect(plan.action).toBe("reject");
  });

  test("rejects a file larger than the user's quota", () => {
    repo.insert(testFileRow(bob, { sizeBytes: 10 })); // alice quota: 500
    const plan = service(1000).planUpload(alice, 600, true);
    expect(plan.action).toBe("reject");
  });

  test("rejects over-quota upload when auto-delete is off", () => {
    repo.insert(testFileRow(alice, { sizeBytes: 800 }));
    const plan = service(1000).planUpload(alice, 300, false);
    expect(plan.action).toBe("reject");
    if (plan.action === "reject") expect(plan.reason).toContain("Over quota");
  });

  test("auto-delete frees oldest files first, only as many as needed", () => {
    const oldest = repo.insert(
      testFileRow(alice, { sizeBytes: 400, createdAt: new Date("2026-01-01") }),
    );
    const middle = repo.insert(
      testFileRow(alice, {
        sizeBytes: 300,
        createdAt: new Date("2026-02-01"),
        status: "approved",
      }),
    );
    repo.insert(
      testFileRow(alice, { sizeBytes: 200, createdAt: new Date("2026-03-01") }),
    );
    // used = 900, quota = 1000, incoming 500 → need to free ≥ 400
    const plan = service(1000).planUpload(alice, 500, true);
    expect(plan.action).toBe("accept");
    if (plan.action === "accept") {
      expect(plan.toDelete.map((f) => f.id)).toEqual([oldest.id]);
    }

    // incoming 800 → need ≥ 700 freed → oldest + middle (status ignored)
    const bigger = service(1000).planUpload(alice, 800, true);
    if (bigger.action === "accept") {
      expect(bigger.toDelete.map((f) => f.id)).toEqual([oldest.id, middle.id]);
    } else {
      throw new Error("expected accept");
    }
  });
});
