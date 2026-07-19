import {
  type ButtonInteraction,
  type Interaction,
  MessageFlags,
} from "discord.js";
import { createLogger } from "@/lib/logger";
import { confirmRow } from "./components";
import { parseReviewCustomId } from "./format";
import type { QuotaSummaryService } from "./quota";
import type { ButtonOutcome, ReviewService } from "./review.service";

const log = createLogger("bot:interactions");

export function uploadReply(baseUrl: string): string {
  // <> suppresses Discord's link preview — the reply is just a pointer.
  return `You can upload and view your files here → <${baseUrl}>`;
}

/**
 * Routes gateway interactions to the review service and renders its outcomes.
 * Kept thin: every decision lives in ReviewService; this file only knows
 * which Discord reply primitive each outcome maps to.
 */
export function createInteractionHandler(deps: {
  review: ReviewService;
  quotaSummary: QuotaSummaryService;
  baseUrl: string;
}): (interaction: Interaction) => Promise<void> {
  return async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "upload") {
          await interaction.reply({
            content: uploadReply(deps.baseUrl),
            flags: MessageFlags.Ephemeral,
          });
        } else if (interaction.commandName === "quota") {
          await interaction.reply({
            content: deps.quotaSummary.summaryFor(interaction.user.id),
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }
      if (interaction.isButton()) await handleButton(interaction, deps.review);
    } catch (err) {
      log.error({ err }, "interaction failed");
      await replyFailure(interaction);
    }
  };
}

async function handleButton(
  interaction: ButtonInteraction,
  review: ReviewService,
): Promise<void> {
  const parsed = parseReviewCustomId(interaction.customId);
  if (!parsed) return;
  const { action, fileId } = parsed;
  const actor = interaction.user.id;

  // Confirm/Cancel live on the ephemeral confirmation reply, so outcomes
  // replace that prompt in place.
  if (action === "cancel") {
    await interaction.update({ content: "Cancelled.", components: [] });
    return;
  }
  if (action === "confirm") {
    const outcome = await review.confirmReject(fileId, actor);
    await interaction.update({
      content: outcome.kind === "ephemeral" ? outcome.content : "Done.",
      components: [],
    });
    return;
  }

  // Approve/Reject live on the channel announcement itself.
  const outcome: ButtonOutcome =
    action === "approve"
      ? await review.approve(fileId, actor)
      : await review.beginReject(fileId, actor);

  switch (outcome.kind) {
    case "update":
      await interaction.update({ content: outcome.content, components: [] });
      return;
    case "confirm":
      await interaction.reply({
        content: outcome.prompt,
        components: [confirmRow(fileId)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    case "ephemeral":
      await interaction.reply({
        content: outcome.content,
        flags: MessageFlags.Ephemeral,
      });
      return;
  }
}

async function replyFailure(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable()) return;
  const content = "Something went wrong — check the bot logs.";
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch {
    // interaction token may have expired — nothing left to do
  }
}
