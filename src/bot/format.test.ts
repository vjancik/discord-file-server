import { describe, expect, test } from "bun:test";
import {
  announcementContent,
  parseReviewCustomId,
  resolvedContent,
  reviewCustomId,
} from "./format";

const file = {
  id: "abc123",
  fileName: "clip.mp4",
  sizeBytes: 1000,
  kind: "video" as const,
};

describe("review message content", () => {
  test("announcement carries the canonical /f/ link for Discord to unfurl", () => {
    const content = announcementContent(file, "Alice", "https://files.test");
    expect(content).toContain("clip.mp4");
    expect(content).toContain("Alice");
    expect(content).toContain("https://files.test/f/abc123/clip.mp4");
  });

  test("markdown in filenames and owner names is escaped", () => {
    const content = announcementContent(
      { ...file, fileName: "**bold**.mp4" },
      "*Alice*",
      "https://files.test",
    );
    expect(content).toContain("\\*\\*bold\\*\\*.mp4");
    expect(content).toContain("\\*Alice\\*");
  });

  test("resolved content appends who did what", () => {
    const approved = resolvedContent(file, "Alice", "https://files.test", {
      kind: "approved",
      byDiscordId: "42",
    });
    expect(approved).toContain("✅ Approved by <@42>");

    const deleted = resolvedContent(file, "Alice", "https://files.test", {
      kind: "deleted",
    });
    expect(deleted).toContain("🗑️ Deleted");
    expect(deleted).not.toContain("by <@");
  });
});

describe("review custom ids", () => {
  test("round-trips every action", () => {
    for (const action of ["approve", "reject", "confirm", "cancel"] as const) {
      expect(parseReviewCustomId(reviewCustomId(action, "abc123"))).toEqual({
        action,
        fileId: "abc123",
      });
    }
  });

  test("rejects foreign or malformed ids", () => {
    expect(parseReviewCustomId("other:approve:abc")).toBeNull();
    expect(parseReviewCustomId("review:nuke:abc")).toBeNull();
    expect(parseReviewCustomId("review:approve")).toBeNull();
    expect(parseReviewCustomId("upload")).toBeNull();
  });
});
