import { and, eq } from "drizzle-orm";
import { account } from "@/db/auth-schema";
import type { Db } from "@/db/client";

/** The Better Auth account row linking a user to Discord (holds tokens + Discord user ID). */
export function getDiscordAccount(db: Db, userId: string) {
  return db
    .select()
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "discord")))
    .get();
}
