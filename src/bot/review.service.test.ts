import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "@/db/client";
import { FileRepository } from "@/server/files/file.repository";
import { FileService } from "@/server/files/file.service";
import { FileStorage } from "@/server/files/storage";
import { createTestDb, insertTestUser, testFileRow } from "@/test/db";
import { DbIdentity } from "./identity";
import {
  MessageGoneError,
  type PostedMessage,
  type ReviewMessage,
  ReviewService,
} from "./review.service";
import { ReviewMessageRepository } from "./review-message.repository";
import { linkDiscordAccount } from "./test-helpers";

const ADMIN_DISCORD_ID = "111";
const BASE_URL = "https://files.test";

/** Records posts/edits; `goneMessageIds` simulates manually deleted messages. */
class FakeMessenger {
  posts: ReviewMessage[] = [];
  edits: { ref: PostedMessage; message: ReviewMessage }[] = [];
  goneMessageIds = new Set<string>();
  private seq = 0;

  async post(message: ReviewMessage): Promise<PostedMessage> {
    this.posts.push(message);
    return { channelId: "chan", messageId: `msg-${++this.seq}` };
  }

  async edit(ref: PostedMessage, message: ReviewMessage): Promise<void> {
    if (this.goneMessageIds.has(ref.messageId)) {
      throw new MessageGoneError("gone");
    }
    this.edits.push({ ref, message });
  }
}

let db: Db;
let cleanup: () => void;
let storageDir: string;
let fileRepo: FileRepository;
let reviewRepo: ReviewMessageRepository;
let messenger: FakeMessenger;
let service: ReviewService;
let alice: string;

beforeEach(() => {
  ({ db, cleanup } = createTestDb());
  storageDir = mkdtempSync(path.join(os.tmpdir(), "bot-review-test-"));
  fileRepo = new FileRepository(db);
  reviewRepo = new ReviewMessageRepository(db);
  messenger = new FakeMessenger();
  service = new ReviewService(
    fileRepo,
    new FileService(fileRepo, new FileStorage(storageDir)),
    reviewRepo,
    messenger,
    new DbIdentity(db),
    { baseUrl: BASE_URL, adminDiscordIds: [ADMIN_DISCORD_ID] },
  );
  alice = insertTestUser(db);
});

afterEach(() => {
  cleanup();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("tick — announcing", () => {
  test("posts each pending file once, with link and buttons", async () => {
    const row = fileRepo.insert(testFileRow(alice));
    await service.tick();
    await service.tick();

    expect(messenger.posts).toHaveLength(1);
    expect(messenger.posts[0].buttons).toBe("decision");
    expect(messenger.posts[0].content).toContain(`/f/${row.id}/`);
    expect(reviewRepo.findByFileId(row.id)).toBeDefined();
  });

  test("ignores files that are already approved or deleted", async () => {
    const approved = fileRepo.insert(testFileRow(alice));
    fileRepo.approve(approved.id);
    const deleted = fileRepo.insert(testFileRow(alice));
    fileRepo.markDeleted(deleted.id, null);

    await service.tick();
    expect(messenger.posts).toHaveLength(0);
  });
});

describe("tick — reconciling web-side changes", () => {
  test("closes the message when the file was approved via the web UI", async () => {
    const row = fileRepo.insert(testFileRow(alice));
    await service.tick();
    fileRepo.approve(row.id); // as the web admin page would

    await service.tick();
    expect(messenger.edits).toHaveLength(1);
    expect(messenger.edits[0].message.buttons).toBe("none");
    expect(messenger.edits[0].message.content).toContain("✅ Approved");
    expect(reviewRepo.findByFileId(row.id)).toBeUndefined();
  });

  test("attributes web deletions via the deleter's linked Discord account", async () => {
    const webAdmin = insertTestUser(db);
    linkDiscordAccount(db, webAdmin, "999");
    const row = fileRepo.insert(testFileRow(alice));
    await service.tick();
    fileRepo.markDeleted(row.id, webAdmin);

    await service.tick();
    expect(messenger.edits[0].message.content).toContain("🗑️ Deleted by <@999>");
  });

  test("drops the tracking row when the Discord message was deleted manually", async () => {
    const row = fileRepo.insert(testFileRow(alice));
    await service.tick();
    const ref = reviewRepo.findByFileId(row.id);
    if (!ref) throw new Error("expected review row");
    messenger.goneMessageIds.add(ref.messageId);
    fileRepo.approve(row.id);

    await service.tick(); // must not throw
    expect(reviewRepo.findByFileId(row.id)).toBeUndefined();
  });
});

describe("approve button", () => {
  test("non-admins are refused with no effect", async () => {
    const row = fileRepo.insert(testFileRow(alice));
    const outcome = await service.approve(row.id, "222");

    expect(outcome.kind).toBe("ephemeral");
    expect(fileRepo.findById(row.id)?.status).toBe("pending");
  });

  test("admin approves: status flips, message resolves, row closes", async () => {
    const row = fileRepo.insert(testFileRow(alice));
    await service.tick();
    const outcome = await service.approve(row.id, ADMIN_DISCORD_ID);

    expect(fileRepo.findById(row.id)?.status).toBe("approved");
    expect(outcome).toMatchObject({ kind: "update" });
    if (outcome.kind !== "update") throw new Error("expected update");
    expect(outcome.content).toContain(`✅ Approved by <@${ADMIN_DISCORD_ID}>`);
    expect(reviewRepo.findByFileId(row.id)).toBeUndefined();
  });

  test("approving a file deleted meanwhile just syncs the message", async () => {
    const row = fileRepo.insert(testFileRow(alice));
    await service.tick();
    fileRepo.markDeleted(row.id, null);

    const outcome = await service.approve(row.id, ADMIN_DISCORD_ID);
    if (outcome.kind !== "update") throw new Error("expected update");
    expect(outcome.content).toContain("🗑️ Deleted");
    expect(fileRepo.findById(row.id)?.status).toBe("pending"); // not double-applied
  });
});

describe("reject flow", () => {
  test("reject asks for confirmation without touching the file", async () => {
    const row = fileRepo.insert(testFileRow(alice));
    const outcome = await service.beginReject(row.id, ADMIN_DISCORD_ID);

    expect(outcome).toMatchObject({ kind: "confirm" });
    if (outcome.kind !== "confirm") throw new Error("expected confirm");
    expect(outcome.prompt).toContain("clip.mp4");
    expect(fileRepo.findLiveById(row.id)).toBeDefined();
  });

  test("confirm deletes bytes, tombstones with the admin's account, closes the message", async () => {
    linkDiscordAccount(db, insertTestUser(db, "admin-user"), ADMIN_DISCORD_ID);
    const row = fileRepo.insert(testFileRow(alice));
    mkdirSync(path.join(storageDir, row.id), { recursive: true });
    await service.tick();

    const outcome = await service.confirmReject(row.id, ADMIN_DISCORD_ID);

    expect(outcome).toMatchObject({ kind: "ephemeral" });
    const tombstone = fileRepo.findById(row.id);
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);
    expect(tombstone?.deletedById).toBe("admin-user");
    expect(messenger.edits).toHaveLength(1);
    expect(messenger.edits[0].message.content).toContain(
      `🗑️ Deleted by <@${ADMIN_DISCORD_ID}>`,
    );
    expect(reviewRepo.findByFileId(row.id)).toBeUndefined();
  });

  test("confirm by a non-admin is refused with no effect", async () => {
    const row = fileRepo.insert(testFileRow(alice));
    const outcome = await service.confirmReject(row.id, "222");

    expect(outcome.kind).toBe("ephemeral");
    expect(fileRepo.findLiveById(row.id)).toBeDefined();
  });

  test("confirm on an already-deleted file is a no-op", async () => {
    const row = fileRepo.insert(testFileRow(alice));
    fileRepo.markDeleted(row.id, null);

    const outcome = await service.confirmReject(row.id, ADMIN_DISCORD_ID);
    if (outcome.kind !== "ephemeral") throw new Error("expected ephemeral");
    expect(outcome.content).toContain("Already deleted");
    expect(fileRepo.findById(row.id)?.deletedById).toBeNull();
  });
});
