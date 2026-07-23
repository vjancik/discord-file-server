import { account } from "@/db/auth-schema";
import type { Db } from "@/db/client";

/** Test-only: link an app user to a Discord account (as signing in would). */
export function linkDiscordAccount(
  db: Db,
  userId: string,
  discordId: string,
): void {
  db.insert(account)
    .values({
      id: `acc-${discordId}`,
      accountId: discordId,
      providerId: "discord",
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}
