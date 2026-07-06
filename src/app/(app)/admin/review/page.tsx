import { requireAdmin } from "@/auth/dal";
import { getEnv } from "@/lib/env";
import { toFileView } from "@/lib/file-view";
import { getContainer } from "@/server/container";
import { ReviewQueue } from "./review-queue";

export const metadata = { title: "Review queue — DiscordFileServer" };

export default async function ReviewPage() {
  const admin = await requireAdmin();
  const { fileRepo, settingsRepo } = getContainer();
  const { baseUrl } = getEnv();

  const pending = (await fileRepo.listPendingWithOwner()).map((f) =>
    toFileView(f, baseUrl),
  );
  const { skipDeleteConfirm } = settingsRepo.get(admin.id);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-2xl">Review queue</h1>
      <ReviewQueue files={pending} skipConfirm={skipDeleteConfirm} />
    </div>
  );
}
