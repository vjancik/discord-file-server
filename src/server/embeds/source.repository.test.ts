import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { files } from "@/db/schema";
import { createTestDb, insertTestUser, testFileRow } from "@/test/db";
import { EmbedSourceRepository } from "./source.repository";

describe("EmbedSourceRepository", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let repo: EmbedSourceRepository;
  let fileId: string;

  beforeEach(() => {
    ctx = createTestDb();
    repo = new EmbedSourceRepository(ctx.db);
    const ownerId = insertTestUser(ctx.db);
    const row = testFileRow(ownerId);
    ctx.db.insert(files).values(row).run();
    fileId = row.id;
  });
  afterEach(() => ctx.cleanup());

  const input = (over: Partial<Parameters<typeof repo.save>[1]> = {}) => ({
    title: "A Video",
    description: "line one\n\nline two",
    sourceUrl: "https://example.com/watch?v=1",
    viewCount: null,
    uploadedAt: null,
    ...over,
  });

  test("save then get round-trips", () => {
    const uploadedAt = new Date("2026-05-17T00:00:00Z");
    repo.save(fileId, input({ viewCount: 1_299_168, uploadedAt }));
    expect(repo.get(fileId)).toEqual({
      fileId,
      title: "A Video",
      description: "line one\n\nline two",
      sourceUrl: "https://example.com/watch?v=1",
      viewCount: 1_299_168,
      uploadedAt,
    });
  });

  test("empty description is stored as null", () => {
    repo.save(fileId, input({ description: "" }));
    expect(repo.get(fileId)?.description).toBeNull();
  });

  test("caps oversized metadata instead of failing", () => {
    repo.save(
      fileId,
      input({
        title: "t".repeat(1_000),
        description: "d".repeat(50_000),
        viewCount: 12.7,
      }),
    );
    const row = repo.get(fileId);
    expect(row?.title.length).toBe(500);
    expect(row?.description?.length).toBe(10_000);
    expect(row?.viewCount).toBe(12); // integers only
  });

  test("save is an upsert", () => {
    repo.save(fileId, input({ title: "old", description: null }));
    repo.save(fileId, input({ title: "new", description: "d", viewCount: 5 }));
    expect(repo.get(fileId)).toMatchObject({
      title: "new",
      description: "d",
      viewCount: 5,
    });
  });

  test("get returns undefined for files without metadata", () => {
    expect(repo.get("missing")).toBeUndefined();
  });

  test("getMany returns only files that have metadata, keyed by file id", () => {
    repo.save(fileId, input());
    const map = repo.getMany([fileId, "no-metadata"]);
    expect(map.size).toBe(1);
    expect(map.get(fileId)?.title).toBe("A Video");
    expect(repo.getMany([]).size).toBe(0);
  });
});
