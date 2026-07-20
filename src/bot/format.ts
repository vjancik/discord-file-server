import { escapeMarkdown } from "discord.js";
import type { FileRow } from "@/db/schema";
import { formatBytes } from "@/lib/units";
import { canonicalUrl } from "@/server/links/urls";

/**
 * Pure text for the admin-channel review messages. The link is the payload:
 * Discord renders it into the embed the upload server already serves via its
 * OG tags, so the bot never builds embeds itself.
 */

/** How a review concluded; rendered as the message's final status line. */
export type ReviewResolution =
  | { kind: "approved"; byDiscordId?: string }
  | { kind: "deleted"; byDiscordId?: string };

export function announcementContent(
  file: Pick<FileRow, "id" | "fileName" | "sizeBytes" | "kind">,
  ownerName: string,
  baseUrl: string,
): string {
  const name = escapeMarkdown(file.fileName);
  const meta = `${formatBytes(file.sizeBytes)} ${file.kind}`;
  const owner = escapeMarkdown(ownerName);
  return `📥 **${name}** — ${meta}, uploaded by **${owner}**\n${canonicalUrl(baseUrl, file)}`;
}

export function resolvedContent(
  file: Pick<FileRow, "id" | "fileName" | "sizeBytes" | "kind">,
  ownerName: string,
  baseUrl: string,
  resolution: ReviewResolution,
): string {
  return `${announcementContent(file, ownerName, baseUrl)}\n${statusLine(resolution)}`;
}

function statusLine(resolution: ReviewResolution): string {
  const by = resolution.byDiscordId ? ` by <@${resolution.byDiscordId}>` : "";
  return resolution.kind === "approved" ? `✅ Approved${by}` : `🗑️ Deleted${by}`;
}

// ── Button custom ids ──────────────────────────────────────────────────────────
// File ids are base64url (no colons), so "review:<action>:<fileId>" is
// unambiguous. `confirm`/`cancel` live on the ephemeral confirmation reply.

export const REVIEW_ACTIONS = [
  "approve",
  "reject",
  "confirm",
  "cancel",
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export function reviewCustomId(action: ReviewAction, fileId: string): string {
  return `review:${action}:${fileId}`;
}

export function parseReviewCustomId(
  customId: string,
): { action: ReviewAction; fileId: string } | null {
  const [prefix, action, fileId] = customId.split(":");
  if (prefix !== "review" || !fileId) return null;
  if (!REVIEW_ACTIONS.includes(action as ReviewAction)) return null;
  return { action: action as ReviewAction, fileId };
}
