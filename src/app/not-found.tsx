import Link from "next/link";
import { AppIcon } from "@/components/app-icon";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <AppIcon className="size-20" />
      <h1 className="font-semibold text-2xl">Page not found</h1>
      <p className="max-w-sm text-center text-muted-foreground">
        The page you are looking for does not exist or has been moved.
      </p>
      <Link href="/" className="underline underline-offset-4">
        Back to home
      </Link>
    </main>
  );
}
