import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { user } from "@/db/auth-schema";
import type { Db } from "@/db/client";
import { createTestDb, insertTestUser } from "@/test/db";
import { DbIdentity } from "./identity";
import { linkDiscordAccount } from "./test-helpers";

let db: Db;
let cleanup: () => void;
let identity: DbIdentity;

beforeEach(() => {
  ({ db, cleanup } = createTestDb());
  identity = new DbIdentity(db);
});
afterEach(() => cleanup());

describe("provisionUser", () => {
  test("creates a user + discord account resolvable both ways", () => {
    const userId = identity.provisionUser({
      discordId: "42",
      username: "viktor",
      avatarUrl: "https://cdn.example/a.png",
    });

    expect(identity.userIdForDiscord("42")).toBe(userId);
    expect(identity.discordIdForUser(userId)).toBe("42");
    const row = db.select().from(user).where(eq(user.id, userId)).get();
    expect(row?.name).toBe("viktor");
    expect(row?.email).toBe("42@discord.placeholder.local");
    expect(row?.emailVerified).toBe(false);
  });

  test("is idempotent for an already-linked Discord user", () => {
    const existing = insertTestUser(db);
    linkDiscordAccount(db, existing, "42");

    expect(identity.provisionUser({ discordId: "42", username: "x" })).toBe(
      existing,
    );
    expect(db.select().from(user).all()).toHaveLength(1);
  });

  test("losing a provisioning race returns the winner's user", () => {
    // Simulate a first web sign-in landing between the existence check and
    // the insert: the not-found check misses once, the insert then hits the
    // unique (providerId, accountId) index, and the loser must recover by
    // returning the winner's user id.
    const winner = insertTestUser(db);
    class RacedIdentity extends DbIdentity {
      private missed = false;
      override userIdForDiscord(discordId: string): string | null {
        if (!this.missed) {
          this.missed = true;
          linkDiscordAccount(db, winner, "42");
          return null;
        }
        return super.userIdForDiscord(discordId);
      }
    }

    const raced = new RacedIdentity(db);
    expect(raced.provisionUser({ discordId: "42", username: "y" })).toBe(
      winner,
    );
    expect(db.select().from(user).all()).toHaveLength(1);
  });
});
