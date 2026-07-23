import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { type UserSettingsRow, userSettings } from "@/db/schema";

const DEFAULTS: Omit<UserSettingsRow, "userId"> = {
  autoDeleteOldest: false,
  skipDeleteConfirm: false,
};

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  /** Settings for a user, falling back to defaults when no row exists yet. */
  get(userId: string): UserSettingsRow {
    const row = this.db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .get();
    return row ?? { userId, ...DEFAULTS };
  }

  update(
    userId: string,
    patch: Partial<Omit<UserSettingsRow, "userId">>,
  ): UserSettingsRow {
    const [row] = this.db
      .insert(userSettings)
      .values({ userId, ...DEFAULTS, ...patch })
      .onConflictDoUpdate({ target: userSettings.userId, set: patch })
      .returning()
      .all();
    return row;
  }
}
