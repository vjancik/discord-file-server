import Link from "next/link";
import { requireAdmin } from "@/auth/dal";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center gap-4 border-b pb-3 text-sm">
        <span className="font-semibold">Admin</span>
        <Link
          href="/admin/review"
          className="text-muted-foreground hover:text-foreground"
        >
          Review queue
        </Link>
        <Link
          href="/admin/files"
          className="text-muted-foreground hover:text-foreground"
        >
          All files
        </Link>
      </nav>
      {children}
    </div>
  );
}
