import { and, eq } from "drizzle-orm";
import { getDiscordAccount } from "@/auth/discord-account";
import { account, user } from "@/db/auth-schema";
import type { Db } from "@/db/client";
import type { Identity } from "./review.service";

/** Discord profile bits used when provisioning an account ahead of sign-in. */
export type DiscordProfile = {
  discordId: string;
  username: string;
  avatarUrl?: string;
};

/** Identity mapping over the shared Better Auth account table. */
export class DbIdentity implements Identity {
  constructor(private readonly db: Db) {}

  /**
   * Returns the app user for a Discord id, creating a real Better Auth
   * user+account pair if none exists (docs/embed-auth.md): their first web
   * sign-in resolves to this account, so files uploaded on their behalf are
   * already theirs. The placeholder email matches what mapProfileToUser
   * synthesizes; the unique (providerId, accountId) index makes the racing
   * first-sign-in case safe — on conflict we re-read and use the winner.
   */
  provisionUser(profile: DiscordProfile): string {
    const existing = this.userIdForDiscord(profile.discordId);
    if (existing !== null) return existing;

    const userId = crypto.randomUUID();
    const now = new Date();
    try {
      this.db.transaction((tx) => {
        tx.insert(user)
          .values({
            id: userId,
            name: profile.username,
            email: `${profile.discordId}@discord.placeholder.local`,
            emailVerified: false,
            image: profile.avatarUrl ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        tx.insert(account)
          .values({
            id: crypto.randomUUID(),
            accountId: profile.discordId,
            providerId: "discord",
            userId,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      });
      return userId;
    } catch (err) {
      // Unique-constraint loss against a concurrent first sign-in (account
      // index or placeholder-email): the transaction rolled back — use the
      // winner's rows.
      const winner = this.userIdForDiscord(profile.discordId);
      if (winner !== null) return winner;
      throw err;
    }
  }

  userIdForDiscord(discordId: string): string | null {
    const row = this.db
      .select({ userId: account.userId })
      .from(account)
      .where(
        and(
          eq(account.providerId, "discord"),
          eq(account.accountId, discordId),
        ),
      )
      .get();
    return row?.userId ?? null;
  }

  discordIdForUser(userId: string): string | null {
    return getDiscordAccount(this.db, userId)?.accountId ?? null;
  }
}
