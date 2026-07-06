"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/auth/dal";
import { getContainer } from "@/server/container";

export async function approveFilesAction(fileIds: string[]): Promise<void> {
  await requireAdmin();
  const { files } = getContainer();
  for (const id of fileIds) {
    files.approve(id);
  }
  revalidatePath("/admin/review");
  revalidatePath("/admin/files");
  revalidatePath("/files");
}
