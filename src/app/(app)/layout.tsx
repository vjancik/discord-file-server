import { FolderOpen, Settings, ShieldCheck, Upload } from "lucide-react";
import Link from "next/link";
import { isAdmin, requireUser } from "@/auth/dal";
import { AppIcon } from "@/components/app-icon";
import { MobileNav } from "@/components/mobile-nav";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const admin = await isAdmin(user.id);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-1 px-4">
          <Link href="/" className="mr-4 flex items-center gap-2 font-semibold">
            <AppIcon className="size-6" />
            Discord File Server
          </Link>
          <nav className="hidden items-center gap-1 text-sm md:flex">
            <Link
              href="/"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
            >
              <Upload className="size-4" /> Upload
            </Link>
            <Link
              href="/files"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
            >
              <FolderOpen className="size-4" /> My files
            </Link>
            <Link
              href="/settings"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
            >
              <Settings className="size-4" /> Settings
            </Link>
            {admin && (
              <Link
                href="/admin/review"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-accent"
              >
                <ShieldCheck className="size-4" /> Admin
              </Link>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-muted-foreground text-sm md:inline">
              {user.name}
            </span>
            <ThemeToggle />
            <div className="hidden md:block">
              <SignOutButton />
            </div>
            <div className="md:hidden">
              <MobileNav admin={admin} userName={user.name} />
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
