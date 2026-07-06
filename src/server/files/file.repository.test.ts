import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "@/db/client";
import { createTestDb, insertTestUser, testFileRow } from "@/test/db";
import { FileRepository } from "./file.repository";

let db: Db;
let cleanup: () => void;
let repo: FileRepository;
let alice: string;
let bob: string;

beforeEach(() => {
  ({ db, cleanup } = createTestDb());
  repo = new FileRepository(db);
  alice = insertTestUser(db);
  bob = insertTestUser(db);
});

afterEach(() => cleanup());

describe("insert & lookup", () => {
  test("finds live files by id and short code", () => {
    const row = repo.insert(testFileRow(alice));
    expect(repo.findLiveById(row.id)?.fileName).toBe("clip.mp4");
    expect(repo.findLiveByShortCode(row.shortCode)?.id).toBe(row.id);
    expect(row.status).toBe("pending");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  test("short codes are unique", () => {
    repo.insert(testFileRow(alice, { shortCode: "dupe1234" }));
    expect(() =>
      repo.insert(testFileRow(alice, { shortCode: "dupe1234" })),
    ).toThrow();
  });
});

describe("tombstone semantics", () => {
  test("markDeleted hides the row from live queries but keeps the record", () => {
    const row = repo.insert(testFileRow(alice));
    repo.markDeleted(row.id, bob);

    expect(repo.findLiveById(row.id)).toBeUndefined();
    expect(repo.findLiveByShortCode(row.shortCode)).toBeUndefined();
    expect(repo.listLiveByOwner(alice)).toHaveLength(0);

    const tombstone = repo.findById(row.id);
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);
    expect(tombstone?.deletedById).toBe(bob);
    expect(tombstone?.fileName).toBe("clip.mp4");
  });

  test("tombstoned files don't count toward sizes or active users", () => {
    const row = repo.insert(testFileRow(alice, { sizeBytes: 500 }));
    repo.insert(testFileRow(bob, { sizeBytes: 300 }));
    expect(repo.countActiveUsers()).toBe(2);
    expect(repo.totalLiveBytes()).toBe(800);

    repo.markDeleted(row.id, alice);
    expect(repo.countActiveUsers()).toBe(1);
    expect(repo.totalLiveBytes()).toBe(300);
    expect(repo.sumLiveSizeByOwner(alice)).toBe(0);
  });
});

describe("quota inputs", () => {
  test("sums live bytes per owner", () => {
    repo.insert(testFileRow(alice, { sizeBytes: 100 }));
    repo.insert(testFileRow(alice, { sizeBytes: 250 }));
    repo.insert(testFileRow(bob, { sizeBytes: 999 }));
    expect(repo.sumLiveSizeByOwner(alice)).toBe(350);
  });

  test("counts a user once regardless of file count", () => {
    repo.insert(testFileRow(alice));
    repo.insert(testFileRow(alice));
    expect(repo.countActiveUsers()).toBe(1);
  });
});

describe("ordering", () => {
  test("oldest-first ordering for auto-delete uses createdAt regardless of status", () => {
    const oldest = repo.insert(
      testFileRow(alice, { createdAt: new Date("2026-01-01") }),
    );
    const newest = repo.insert(
      testFileRow(alice, { createdAt: new Date("2026-03-01") }),
    );
    const middle = repo.insert(
      testFileRow(alice, {
        createdAt: new Date("2026-02-01"),
        status: "approved",
      }),
    );

    const ordered = repo.listLiveByOwnerOldestFirst(alice).map((f) => f.id);
    expect(ordered).toEqual([oldest.id, middle.id, newest.id]);
  });
});

describe("review workflow", () => {
  test("pending queue lists live pending files with owner, oldest first", async () => {
    const a = repo.insert(
      testFileRow(alice, { createdAt: new Date("2026-01-02") }),
    );
    const b = repo.insert(
      testFileRow(bob, { createdAt: new Date("2026-01-01") }),
    );
    repo.insert(testFileRow(alice, { status: "approved" }));
    const deleted = repo.insert(testFileRow(alice));
    repo.markDeleted(deleted.id, alice);

    const queue = await repo.listPendingWithOwner();
    expect(queue.map((f) => f.id)).toEqual([b.id, a.id]);
    expect(queue[0].owner.id).toBe(bob);
  });

  test("approve flips status", () => {
    const row = repo.insert(testFileRow(alice));
    repo.approve(row.id);
    expect(repo.findLiveById(row.id)?.status).toBe("approved");
  });
});

describe("expiry", () => {
  test("listExpired returns only live files past their expiresAt", () => {
    const past = repo.insert(
      testFileRow(alice, { expiresAt: new Date(Date.now() - 1000) }),
    );
    repo.insert(
      testFileRow(alice, { expiresAt: new Date(Date.now() + 60_000) }),
    );
    repo.insert(testFileRow(alice)); // no expiry
    const deletedPast = repo.insert(
      testFileRow(alice, { expiresAt: new Date(Date.now() - 1000) }),
    );
    repo.markDeleted(deletedPast.id, alice);

    expect(repo.listExpired().map((f) => f.id)).toEqual([past.id]);
  });
});
