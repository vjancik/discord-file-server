import { isAdmin, requireUser } from "@/auth/dal";
import { SiteHeader } from "@/components/site-header";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const admin = await isAdmin(user.id);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader user={user} admin={admin} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
