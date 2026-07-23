import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import { reviewCustomId } from "./format";

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

/** Approve / Reject on the channel announcement. */
export function decisionRow(fileId: string): Row {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(reviewCustomId("approve", fileId))
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(reviewCustomId("reject", fileId))
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );
}

/** Confirm / Cancel on the ephemeral delete-confirmation reply. */
export function confirmRow(fileId: string): Row {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(reviewCustomId("confirm", fileId))
      .setLabel("Delete file")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(reviewCustomId("cancel", fileId))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}
