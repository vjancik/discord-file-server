"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/auth/dal";
import { getContainer } from "@/server/container";

export async function updateSettingsAction(patch: {
  autoDeleteOldest?: boolean;
  skipDeleteConfirm?: boolean;
  stripMediaMetadata?: boolean;
  stripDocumentMetadata?: boolean;
}): Promise<void> {
  const user = await requireUser();
  getContainer().settingsRepo.update(user.id, patch);
  revalidatePath("/settings");
}
