"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { updateSettingsAction } from "./actions";

interface Props {
  autoDeleteOldest: boolean;
  skipDeleteConfirm: boolean;
  stripMediaMetadata: boolean;
  stripDocumentMetadata: boolean;
}

export function SettingsForm({
  autoDeleteOldest,
  skipDeleteConfirm,
  stripMediaMetadata,
  stripDocumentMetadata,
}: Props) {
  const [pending, startTransition] = useTransition();

  const update = (patch: Parameters<typeof updateSettingsAction>[0]) =>
    startTransition(async () => {
      await updateSettingsAction(patch);
      toast.success("Settings saved");
    });

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4 rounded-md border p-4">
        <div>
          <Label htmlFor="auto-delete">
            Auto-delete oldest files to free quota
          </Label>
          <p className="mt-1 text-muted-foreground text-sm">
            When an upload doesn&apos;t fit your quota, your oldest files are
            deleted automatically until it does. When disabled, the upload is
            rejected instead.
          </p>
        </div>
        <Switch
          id="auto-delete"
          checked={autoDeleteOldest}
          disabled={pending}
          onCheckedChange={(v) => update({ autoDeleteOldest: v })}
        />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md border p-4">
        <div>
          <Label htmlFor="delete-confirm">Ask before deleting files</Label>
          <p className="mt-1 text-muted-foreground text-sm">
            Shows a confirmation dialog whenever you delete a file. Turned off
            by the &quot;don&apos;t show this again&quot; checkbox; re-enable it
            here.
          </p>
        </div>
        <Switch
          id="delete-confirm"
          checked={!skipDeleteConfirm}
          disabled={pending}
          onCheckedChange={(v) => update({ skipDeleteConfirm: !v })}
        />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md border p-4">
        <div>
          <Label htmlFor="strip-media">
            Remove metadata from photos, video &amp; audio
          </Label>
          <p className="mt-1 text-muted-foreground text-sm">
            Strips GPS location, device info and other embedded metadata from
            uploaded media before it&apos;s published. Image pixels and
            audio/video streams are untouched — no re-encoding.
          </p>
        </div>
        <Switch
          id="strip-media"
          checked={stripMediaMetadata}
          disabled={pending}
          onCheckedChange={(v) => update({ stripMediaMetadata: v })}
        />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md border p-4">
        <div>
          <Label htmlFor="strip-documents">
            Remove metadata from documents &amp; other files
          </Label>
          <p className="mt-1 text-muted-foreground text-sm">
            Strips author and account names from PDFs and Office documents
            (docx, xlsx, pptx, odt…), and timestamps/ownership info from zip
            archives. Files inside archives are never modified.
          </p>
        </div>
        <Switch
          id="strip-documents"
          checked={stripDocumentMetadata}
          disabled={pending}
          onCheckedChange={(v) => update({ stripDocumentMetadata: v })}
        />
      </div>
    </div>
  );
}
