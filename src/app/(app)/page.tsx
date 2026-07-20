import { requireUser } from "@/auth/dal";
import { formatBytes } from "@/lib/units";
import { getContainer } from "@/server/container";
import { UploadPanel } from "./upload-panel";

export const metadata = { title: "Upload — Discord File Server" };

export default async function UploadPage() {
  const user = await requireUser();
  const { quota } = getContainer();
  const limit = quota.quotaFor(user.id);
  const used = quota.usageFor(user.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="font-semibold text-2xl">Upload</h1>
        <p className="text-muted-foreground text-sm">
          {formatBytes(used)} of {formatBytes(limit)} used
        </p>
      </div>
      <UploadPanel remainingBytes={Math.max(0, limit - used)} />
    </div>
  );
}
