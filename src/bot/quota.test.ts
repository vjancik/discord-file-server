import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "@/db/client";
import { FileRepository } from "@/server/files/file.repository";
import { QuotaService } from "@/server/quota/quota.service";
import { createTestDb, insertTestUser, testFileRow } from "@/test/db";
import { DbIdentity } from "./identity";
import { QuotaSummaryService } from "./quota";
import { linkDiscordAccount } from "./test-helpers";

const BASE_URL = "https://files.test";

let db: Db;
let cleanup: () => void;
let fileRepo: FileRepository;
let alice: string;

beforeEach(() => {
  ({ db, cleanup } = createTestDb());
  fileRepo = new FileRepository(db);
  alice = insertTestUser(db);
  linkDiscordAccount(db, alice, "111");
});

afterEach(() => cleanup());

const summary = (storageLimit: number) =>
  new QuotaSummaryService(
    new QuotaService(fileRepo, { storageLimit }),
    fileRepo,
    new DbIdentity(db),
    BASE_URL,
  );

describe("/quota summary", () => {
  test("unregistered Discord user gets the prospective share and a sign-in nudge", () => {
    fileRepo.insert(testFileRow(alice, { sizeBytes: 100 }));
    const text = summary(900).summaryFor("no-such-discord-id");

    // 1 active user + the newcomer = 450, not the active-user share of 900
    expect(text).toContain("**450 B**");
    expect(text).toContain(BASE_URL);
    expect(text).toContain("sign in");
  });

  test("registered user with no live files is not double-counted", () => {
    const bob = insertTestUser(db);
    fileRepo.insert(testFileRow(bob, { sizeBytes: 100 }));

    // alice holds nothing: divisor = 1 active + her = 2 → 450, usage 0
    const text = summary(900).summaryFor("111");
    expect(text).toContain("**0 B** of your **450 B**");
    expect(text).toContain("0 files");
  });

  test("active user sees usage, quota, and free space", () => {
    fileRepo.insert(testFileRow(alice, { sizeBytes: 100 }));
    fileRepo.insert(testFileRow(alice, { sizeBytes: 200 }));

    const text = summary(900).summaryFor("111");
    expect(text).toContain("**300 B** of your **900 B**");
    expect(text).toContain("2 files");
    expect(text).toContain("**600 B** free");
  });

  test("over the shrunken quota: free clamps to zero and a warning explains it", () => {
    fileRepo.insert(testFileRow(alice, { sizeBytes: 800 }));
    const bob = insertTestUser(db);
    fileRepo.insert(testFileRow(bob, { sizeBytes: 10 })); // alice's quota drops to 450

    const text = summary(900).summaryFor("111");
    expect(text).toContain("**0 B** free");
    expect(text).toContain("⚠️");
    expect(text).toContain("**350 B** over"); // 800 used − 450 quota
    expect(text).toContain("delete some older files");
  });

  test("no over-quota warning when within the limit", () => {
    fileRepo.insert(testFileRow(alice, { sizeBytes: 100 }));
    expect(summary(900).summaryFor("111")).not.toContain("⚠️");
  });

  test("tombstoned files don't count toward usage", () => {
    const row = fileRepo.insert(testFileRow(alice, { sizeBytes: 500 }));
    fileRepo.markDeleted(row.id, alice);

    const text = summary(900).summaryFor("111");
    expect(text).toContain("**0 B** of your");
  });
});
