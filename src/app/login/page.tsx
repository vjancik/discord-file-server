import { redirect } from "next/navigation";
import { getSession } from "@/auth/dal";
import { AppIcon } from "@/components/app-icon";
import { SignInButton } from "./sign-in-button";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Real session check (not cookie presence): signed-in users go home,
  // stale-cookie visitors get the login page instead of a redirect loop.
  if (await getSession()) redirect("/");

  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <AppIcon className="size-20" />
      <h1 className="font-semibold text-2xl">Discord File Server</h1>
      <p className="max-w-sm text-center text-neutral-400">
        Share files with your Discord community without the upload limits.
      </p>
      <SignInButton />
      {error && (
        <p className="max-w-sm text-center text-red-400 text-sm">
          {error === "forbidden"
            ? "You must be a member of an allowed Discord server to use this service."
            : "Sign-in failed. Please try again."}
        </p>
      )}
    </main>
  );
}
