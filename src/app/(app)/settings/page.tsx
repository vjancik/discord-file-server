import { requireUser } from "@/auth/dal";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/units";
import { getContainer } from "@/server/container";
import { SettingsForm } from "./settings-form";

export const metadata = { title: "Settings — Discord File Server" };

export default async function SettingsPage() {
  const user = await requireUser();
  const { settingsRepo, quota } = getContainer();

  const settings = settingsRepo.get(user.id);
  const limit = quota.quotaFor(user.id);
  const used = quota.usageFor(user.id);
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="font-semibold text-2xl">Settings</h1>

      <section className="flex max-w-xl flex-col gap-3">
        <h2 className="font-medium text-lg">Quota</h2>
        <Progress value={pct} />
        <p className="text-muted-foreground text-sm">
          {formatBytes(used)} of {formatBytes(limit)} used ({pct}%). Your quota
          is a share of the server&apos;s total storage and changes as users
          join or leave.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg">Preferences</h2>
        <SettingsForm
          autoDeleteOldest={settings.autoDeleteOldest}
          skipDeleteConfirm={settings.skipDeleteConfirm}
          stripMediaMetadata={settings.stripMediaMetadata}
          stripDocumentMetadata={settings.stripDocumentMetadata}
        />
      </section>
    </div>
  );
}
