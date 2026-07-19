import { and, eq } from "drizzle-orm";
import { getDiscordAccount } from "@/auth/discord-account";
import { account } from "@/db/auth-schema";
import type { Db } from "@/db/client";
import type { Identity } from "./review.service";

/** Identity mapping over the shared Better Auth account table. */
export class DbIdentity implements Identity {
  constructor(private readonly db: Db) {}

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
