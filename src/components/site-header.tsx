import { FolderOpen, LogIn, Settings, ShieldCheck, Upload } from "lucide-react";
import Link from "next/link";
import { AppIcon } from "@/components/app-icon";
import { MobileNav } from "@/components/mobile-nav";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

/**
 * Top nav shared by the authenticated app frame and public pages (the /v
 * watch page). Signed-out visitors get a Sign in button where Sign out
 * usually sits and no nav items; the theme toggle is always there.
 */
export function SiteHeader({
  user,
  admin = false,
}: {
  user: { name: string } | null;
  admin?: boolean;
}) {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-1 px-4">
        <Link href="/" className="mr-4 flex items-center gap-2 font-semibold">
          <AppIcon className="size-6" />
          Discord File Server
        </Link>
        {user && (
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
        )}
        <div className="ml-auto flex items-center gap-2">
          {user ? (
            <>
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
            </>
          ) : (
            <>
              <ThemeToggle />
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">
                  <LogIn />
                  Sign in
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
