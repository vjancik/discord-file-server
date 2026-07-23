"use server";

import { revalidatePath } from "next/cache";
import { isAdmin, requireUser } from "@/auth/dal";
import { getContainer } from "@/server/container";

export async function deleteFileAction(
  fileId: string,
): Promise<{ error?: string }> {
  const user = await requireUser();
  const { fileRepo, files } = getContainer();

  const file = fileRepo.findById(fileId);
  if (!file) return { error: "File not found." };
  if (file.ownerId !== user.id && !(await isAdmin(user.id))) {
    return { error: "You can only delete your own files." };
  }

  await files.delete(fileId, user.id);
  revalidatePath("/files");
  revalidatePath("/admin/files");
  revalidatePath("/admin/review");
  return {};
}

export async function setSkipDeleteConfirmAction(skip: boolean): Promise<void> {
  const user = await requireUser();
  getContainer().settingsRepo.update(user.id, { skipDeleteConfirm: skip });
  revalidatePath("/settings");
}
