import { requireUser } from "@/auth/dal";
import { getEnv } from "@/lib/env";
import { toFileView } from "@/lib/file-view";
import { getContainer } from "@/server/container";
import { FilesTable } from "./files-table";

export const metadata = { title: "My files — Discord File Server" };

export default async function FilesPage() {
  const user = await requireUser();
  const { fileRepo, settingsRepo, embedSources } = getContainer();
  const { baseUrl } = getEnv();

  const rows = fileRepo.listLiveByOwner(user.id);
  const sources = embedSources.getMany(rows.map((f) => f.id));
  const files = rows.map((f) => toFileView(f, baseUrl, sources.get(f.id)));
  const { skipDeleteConfirm } = settingsRepo.get(user.id);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-2xl">My files</h1>
      <FilesTable files={files} skipConfirm={skipDeleteConfirm} />
    </div>
  );
}
