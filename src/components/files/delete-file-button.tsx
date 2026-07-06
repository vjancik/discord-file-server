"use client";

import { Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  deleteFileAction,
  setSkipDeleteConfirmAction,
} from "@/app/(app)/files/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

/**
 * Delete with confirmation dialog + global "don't show this again" opt-out
 * (PRD §6) — used by the dashboard and both admin views.
 */
export function DeleteFileButton({
  fileId,
  fileName,
  skipConfirm,
}: {
  fileId: string;
  fileName: string;
  skipConfirm: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [pending, startTransition] = useTransition();

  const doDelete = () =>
    startTransition(async () => {
      const { error } = await deleteFileAction(fileId);
      if (error) {
        toast.error(error);
      } else {
        toast.success(`Deleted ${fileName}`);
        if (dontAskAgain) await setSkipDeleteConfirmAction(true);
      }
      setOpen(false);
    });

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete ${fileName}`}
        disabled={pending}
        onClick={() => (skipConfirm ? doDelete() : setOpen(true))}
      >
        <Trash2 className="text-destructive" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete file?</DialogTitle>
            <DialogDescription>
              <span className="break-all font-medium">{fileName}</span> will be
              removed and every shared link to it will stop working immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`dont-ask-${fileId}`}
              checked={dontAskAgain}
              onCheckedChange={(v) => setDontAskAgain(v === true)}
            />
            <Label
              htmlFor={`dont-ask-${fileId}`}
              className="font-normal text-sm"
            >
              Don&apos;t show this again
            </Label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={doDelete} disabled={pending}>
              {pending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
