"use client";

import { Check } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { DeleteFileButton } from "@/components/files/delete-file-button";
import { DownloadFileButton } from "@/components/files/download-file-button";
import { DateCell, KindIcon } from "@/components/files/file-cells";
import { FilePreview } from "@/components/files/preview-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { FileView } from "@/lib/file-view";
import { formatBytes } from "@/lib/units";
import { cn } from "@/lib/utils";
import { approveFilesAction } from "../actions";

/**
 * Review queue (PRD §6): preview is the primary interaction — clicking a row
 * shows the file in an always-visible preview pane. Approve / Delete only;
 * bulk approve via row selection.
 */
export function ReviewQueue({
  files,
  skipConfirm,
}: {
  files: FileView[];
  skipConfirm: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    files[0]?.id ?? null,
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const selected = files.find((f) => f.id === selectedId) ?? null;

  const approve = (ids: string[]) =>
    startTransition(async () => {
      await approveFilesAction(ids);
      toast.success(
        ids.length === 1 ? "File approved" : `${ids.length} files approved`,
      );
      setChecked(new Set());
    });

  if (files.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-8 text-center text-muted-foreground">
        Nothing pending review.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={checked.size === 0 || pending}
          onClick={() => approve([...checked])}
        >
          <Check /> Approve selected ({checked.size})
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <ul className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto rounded-md border p-2">
          {files.map((file) => (
            <li key={file.id} className="flex items-center gap-2">
              <Checkbox
                aria-label={`Select ${file.fileName}`}
                checked={checked.has(file.id)}
                onCheckedChange={(v) => {
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (v === true) next.add(file.id);
                    else next.delete(file.id);
                    return next;
                  });
                }}
              />
              <button
                type="button"
                onClick={() => setSelectedId(file.id)}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                  selectedId === file.id && "bg-accent",
                )}
              >
                <KindIcon kind={file.kind} />
                <span className="min-w-0 flex-1 truncate" title={file.fileName}>
                  {file.fileName}
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {file.ownerName} · {formatBytes(file.sizeBytes)}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-3 rounded-md border p-4">
          {selected ? (
            <>
              <div className="flex items-center gap-2">
                <h2
                  className="min-w-0 flex-1 truncate font-medium"
                  title={selected.fileName}
                >
                  {selected.fileName}
                </h2>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => approve([selected.id])}
                >
                  <Check /> Approve
                </Button>
                <DownloadFileButton file={selected} />
                <DeleteFileButton
                  fileId={selected.id}
                  fileName={selected.fileName}
                  skipConfirm={skipConfirm}
                />
              </div>
              <p className="text-muted-foreground text-sm">
                {selected.ownerName} · {selected.mimeType} ·{" "}
                {formatBytes(selected.sizeBytes)} ·{" "}
                <DateCell iso={selected.createdAt} />
              </p>
              <FilePreview file={selected} />
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Select a file to preview.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
