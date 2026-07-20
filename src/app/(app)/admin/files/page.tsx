import { requireAdmin } from "@/auth/dal";
import { getEnv } from "@/lib/env";
import { toFileView } from "@/lib/file-view";
import { getContainer } from "@/server/container";
import { AdminFilesTable } from "./admin-files-table";

export const metadata = { title: "All files — Discord File Server" };

export default async function AdminFilesPage() {
  const admin = await requireAdmin();
  const { fileRepo, settingsRepo } = getContainer();
  const { baseUrl } = getEnv();

  const files = (await fileRepo.listAllWithOwner()).map((f) =>
    toFileView(f, baseUrl),
  );
  const { skipDeleteConfirm } = settingsRepo.get(admin.id);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-2xl">All files</h1>
      <AdminFilesTable files={files} skipConfirm={skipDeleteConfirm} />
    </div>
  );
}
