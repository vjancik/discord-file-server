import {
  type Client,
  DiscordAPIError,
  RESTJSONErrorCodes,
  type SendableChannels,
} from "discord.js";
import { decisionRow } from "./components";
import {
  MessageGoneError,
  type PostedMessage,
  type ReviewMessage,
  type ReviewMessenger,
} from "./review.service";

/**
 * ReviewMessenger over discord.js. Posts go to the fixed admin channel; the
 * link in the content unfurls into the upload server's own OG embed.
 */
export class DiscordReviewMessenger implements ReviewMessenger {
  private channel: SendableChannels | undefined;

  constructor(
    private readonly client: Client,
    private readonly channelId: string,
  ) {}

  private async adminChannel(): Promise<SendableChannels> {
    if (this.channel) return this.channel;
    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel?.isSendable()) {
      throw new Error(
        `ADMIN_CHANNEL_ID ${this.channelId} is not a sendable channel (check the id and the bot's permissions).`,
      );
    }
    this.channel = channel;
    return channel;
  }

  async post(message: ReviewMessage): Promise<PostedMessage> {
    const channel = await this.adminChannel();
    const sent = await channel.send({
      content: message.content,
      components:
        message.buttons === "decision" ? [decisionRow(message.fileId)] : [],
    });
    return { channelId: channel.id, messageId: sent.id };
  }

  async edit(ref: PostedMessage, message: ReviewMessage): Promise<void> {
    const channel = await this.adminChannel();
    try {
      await channel.messages.edit(ref.messageId, {
        content: message.content,
        components:
          message.buttons === "decision" ? [decisionRow(message.fileId)] : [],
      });
    } catch (err) {
      if (
        err instanceof DiscordAPIError &&
        err.code === RESTJSONErrorCodes.UnknownMessage
      ) {
        throw new MessageGoneError(`message ${ref.messageId} is gone`);
      }
      throw err;
    }
  }
}
