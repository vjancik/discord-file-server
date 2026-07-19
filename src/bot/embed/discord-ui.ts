import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  ComponentType,
  type InteractionCollector,
  type Message,
  MessageFlags,
} from "discord.js";
import { createLogger } from "@/lib/logger";
import type { AskOption, EmbedUi } from "./embed.service";

const log = createLogger("bot:embed-ui");

/** Interaction webhooks die at 15 min; switch to a bot-owned message before. */
const TOKEN_SAFE_MS = 13 * 60_000;
/** Outer bound for the job's button collector. */
const COLLECTOR_LIFETIME_MS = 6 * 60 * 60_000;

const STYLE = {
  primary: ButtonStyle.Primary,
  danger: ButtonStyle.Danger,
  secondary: ButtonStyle.Secondary,
} as const;

/**
 * EmbedUi over a deferred public interaction reply (docs/embed-video.md):
 * status edits + an always-available Abort button, invoker-only dialogs, and
 * the >15 min switch to a regular bot-authored channel message (which needs
 * Send Messages permission in the invoking channel).
 */
export class DiscordEmbedUi implements EmbedUi {
  private readonly startedAt = Date.now();
  private message: Message | null = null;
  private usingChannelMessage = false;
  private collector: InteractionCollector<ButtonInteraction> | null = null;
  private pendingAsk: ((id: string) => void) | null = null;
  private askIds = new Set<string>();
  private done = false;

  constructor(
    private readonly interaction: ChatInputCommandInteraction,
    private readonly jobId: string,
    private readonly abort: AbortController,
  ) {}

  async status(text: string): Promise<void> {
    if (this.done) return;
    await this.edit({ content: text, components: [this.abortRow()] }).catch(
      (err) => log.warn({ err }, "status edit failed"),
    );
  }

  async ask(
    text: string,
    options: AskOption[],
    timeoutMs: number,
  ): Promise<string | "timeout"> {
    this.askIds = new Set(options.map((o) => o.id));
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      options.map((o) =>
        new ButtonBuilder()
          .setCustomId(this.customId(o.id))
          .setLabel(o.label)
          .setStyle(STYLE[o.style]),
      ),
    );
    await this.edit({ content: text, components: [row] });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAsk = null;
        resolve("timeout");
      }, timeoutMs);
      this.pendingAsk = (id) => {
        clearTimeout(timer);
        this.pendingAsk = null;
        resolve(id);
      };
    });
  }

  async finish(text: string): Promise<void> {
    this.done = true;
    this.collector?.stop();
    await this.edit({ content: text, components: [] }).catch((err) =>
      log.warn({ err }, "finish edit failed"),
    );
  }

  private customId(id: string): string {
    return `embed:${this.jobId}:${id}`;
  }

  private abortRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(this.customId("abort"))
        .setLabel("Abort")
        .setStyle(ButtonStyle.Danger),
    );
  }

  private async edit(payload: {
    content: string;
    components: ActionRowBuilder<ButtonBuilder>[];
  }): Promise<void> {
    // Past the webhook token's safe window, migrate to a channel message the
    // bot can edit forever. Old reply keeps its last content as history.
    if (
      !this.usingChannelMessage &&
      Date.now() - this.startedAt > TOKEN_SAFE_MS
    ) {
      const channel = this.interaction.channel;
      if (channel?.isSendable()) {
        this.collector?.stop();
        this.collector = null;
        this.message = await channel.send(payload);
        this.usingChannelMessage = true;
        this.ensureCollector();
        return;
      }
      log.warn("cannot send channel message; sticking with webhook edits");
    }

    this.message =
      this.usingChannelMessage && this.message
        ? await this.message.edit(payload)
        : await this.interaction.editReply(payload);
    this.ensureCollector();
  }

  private ensureCollector(): void {
    if (this.collector || !this.message) return;
    this.collector = this.message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: COLLECTOR_LIFETIME_MS,
    });
    this.collector.on("collect", (press) => void this.onPress(press));
  }

  private async onPress(press: ButtonInteraction): Promise<void> {
    try {
      if (press.user.id !== this.interaction.user.id) {
        await press.reply({
          content: "Only the requester can use these buttons.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const id = press.customId.split(":")[2];
      await press.deferUpdate();
      if (id === "abort") {
        this.abort.abort();
        return;
      }
      if (this.pendingAsk && this.askIds.has(id)) this.pendingAsk(id);
    } catch (err) {
      log.warn({ err }, "button press handling failed");
    }
  }
}
