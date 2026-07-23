// E2E helper (run with bun): links a fake Discord account to a user so the
// ADMIN_DISCORD_IDS check passes. Usage:
//   DATABASE_PATH=./.data/e2e/db.sqlite bun scripts/e2e-make-admin.ts <email> <discord-id>
import { eq } from "drizzle-orm";
import { account, user } from "@/db/auth-schema";
import { getDb } from "@/db/client";

const [email, discordId] = process.argv.slice(2);
if (!email || !discordId) {
  console.error("usage: bun scripts/e2e-make-admin.ts <email> <discord-id>");
  process.exit(1);
}

const db = getDb();
const target = db.select().from(user).where(eq(user.email, email)).get();
if (!target) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}

db.insert(account)
  .values({
    id: `e2e-admin-${Date.now()}`,
    accountId: discordId,
    providerId: "discord",
    userId: target.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  .run();

console.log(`linked ${email} to discord account ${discordId}`);
