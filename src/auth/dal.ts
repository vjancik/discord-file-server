import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { auth } from "./auth";
import { getDiscordAccount } from "./discord-account";

export const getSession = cache(async () => {
  return await auth.api.getSession({ headers: await headers() });
});

/** Session user or redirect to /login. Use in every authenticated page/action. */
export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session.user;
}

/** Admin = the linked Discord account's user ID is listed in ADMIN_DISCORD_IDS. */
export const isAdmin = cache(async (userId: string): Promise<boolean> => {
  const discordAccount = getDiscordAccount(getDb(), userId);
  if (!discordAccount) return false;
  return getEnv().ADMIN_DISCORD_IDS.includes(discordAccount.accountId);
});

/** Session user if they are an admin; 404s otherwise (admin routes stay unadvertised). */
export async function requireAdmin() {
  const user = await requireUser();
  if (!(await isAdmin(user.id))) {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  return user;
}
