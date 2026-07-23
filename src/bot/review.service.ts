import type { FileRow } from "@/db/schema";
import { createLogger } from "@/lib/logger";
import { formatBytes } from "@/lib/units";
import type { FileRepository } from "@/server/files/file.repository";
import type { FileService } from "@/server/files/file.service";
import {
  announcementContent,
  type ReviewResolution,
  resolvedContent,
} from "./format";
import type {
  ReviewMessageRef,
  ReviewMessageRepository,
} from "./review-message.repository";

/** Discord user id ↔ upload-server user id, backed by the Better Auth account table. */
export interface Identity {
  userIdForDiscord(discordId: string): string | null;
  discordIdForUser(userId: string): string | null;
}

/** Thrown by ReviewMessenger.edit when the Discord message was deleted out from under us. */
export class MessageGoneError extends Error {}

export interface PostedMessage {
  channelId: string;
  messageId: string;
}

export interface ReviewMessage {
  content: string;
  /** "decision" = show Approve/Reject buttons; "none" = buttons removed. */
  buttons: "decision" | "none";
  fileId: string;
}

/** The one Discord-facing seam; implemented over discord.js in messenger.ts. */
export interface ReviewMessenger {
  post(message: ReviewMessage): Promise<PostedMessage>;
  edit(ref: PostedMessage, message: ReviewMessage): Promise<void>;
}

/** What the interaction layer should do in response to a button press. */
export type ButtonOutcome =
  /** Edit the channel message in place (buttons removed). */
  | { kind: "update"; content: string }
  /** Show an ephemeral note to the clicking user only. */
  | { kind: "ephemeral"; content: string }
  /** Ask for delete confirmation (ephemeral, with Confirm/Cancel buttons). */
  | { kind: "confirm"; prompt: string };

const NOT_ALLOWED = "Only upload-server admins can review files.";

/**
 * All review-flow decisions, kept free of discord.js so they unit-test with
 * fakes. The bot's poll loop calls `tick()`; button presses route to
 * `approve` / `beginReject` / `confirmReject`.
 *
 * Everything here is idempotent and race-tolerant: the web UI can approve or
 * delete a file at any moment, ticks and clicks can interleave, and the
 * Discord message itself can be deleted by a human. The shared SQLite rows
 * are the source of truth; messages are reconciled toward them.
 */
export class ReviewService {
  private readonly log = createLogger("bot:review");

  constructor(
    private readonly fileRepo: FileRepository,
    private readonly files: FileService,
    private readonly reviewRepo: ReviewMessageRepository,
    private readonly messenger: ReviewMessenger,
    private readonly identity: Identity,
    private readonly opts: { baseUrl: string; adminDiscordIds: string[] },
  ) {}

  /** One poll iteration: announce new pending files, then sync open messages. */
  async tick(): Promise<void> {
    await this.announceNewPending();
    await this.reconcileOpen();
  }

  private async announceNewPending(): Promise<void> {
    const pending = await this.fileRepo.listPendingWithOwner();
    const open = new Set(this.reviewRepo.listOpen().map((r) => r.fileId));
    for (const file of pending) {
      if (open.has(file.id)) continue;
      const content = announcementContent(
        file,
        file.owner.name,
        this.opts.baseUrl,
      );
      const posted = await this.messenger.post({
        content,
        buttons: "decision",
        fileId: file.id,
      });
      this.reviewRepo.insert({ fileId: file.id, ...posted });
      this.log.info({ fileId: file.id }, "announced pending file for review");
    }
  }

  /** Files resolved via the web UI (or expiry) still have an open message — close it. */
  private async reconcileOpen(): Promise<void> {
    for (const ref of this.reviewRepo.listOpen()) {
      const file = this.fileRepo.findById(ref.fileId);
      if (!file) {
        this.reviewRepo.delete(ref.fileId);
        continue;
      }
      const resolution = this.resolutionFor(file);
      if (!resolution) continue; // still pending — leave the buttons up
      await this.closeMessage(ref, file, resolution);
    }
  }

  /** How a no-longer-pending file was resolved, for the message status line. */
  private resolutionFor(file: FileRow): ReviewResolution | null {
    if (file.deletedAt) {
      return {
        kind: "deleted",
        byDiscordId: file.deletedById
          ? (this.identity.discordIdForUser(file.deletedById) ?? undefined)
          : undefined,
      };
    }
    if (file.status === "approved") return { kind: "approved" };
    return null;
  }

  private async closeMessage(
    ref: ReviewMessageRef,
    file: FileRow,
    resolution: ReviewResolution,
  ): Promise<string> {
    const ownerName = (await this.fileRepo.ownerName(file.ownerId)) ?? "?";
    const content = resolvedContent(
      file,
      ownerName,
      this.opts.baseUrl,
      resolution,
    );
    try {
      await this.messenger.edit(ref, {
        content,
        buttons: "none",
        fileId: file.id,
      });
    } catch (err) {
      if (!(err instanceof MessageGoneError)) throw err;
      this.log.warn({ fileId: file.id }, "review message was deleted manually");
    }
    this.reviewRepo.delete(file.id);
    return content;
  }

  private isAdmin(discordId: string): boolean {
    return this.opts.adminDiscordIds.includes(discordId);
  }

  async approve(
    fileId: string,
    actorDiscordId: string,
  ): Promise<ButtonOutcome> {
    if (!this.isAdmin(actorDiscordId)) {
      return { kind: "ephemeral", content: NOT_ALLOWED };
    }
    const file = this.fileRepo.findById(fileId);
    if (!file) {
      this.reviewRepo.delete(fileId);
      return { kind: "ephemeral", content: "This file no longer exists." };
    }
    // Already resolved elsewhere (web UI, expiry, another admin) — just sync
    // the message to reality instead of double-applying.
    const already = this.resolutionFor(file);
    if (already) return await this.resolveInPlace(fileId, file, already);

    this.files.approve(fileId);
    return await this.resolveInPlace(
      fileId,
      { ...file, status: "approved" },
      {
        kind: "approved",
        byDiscordId: actorDiscordId,
      },
    );
  }

  async beginReject(
    fileId: string,
    actorDiscordId: string,
  ): Promise<ButtonOutcome> {
    if (!this.isAdmin(actorDiscordId)) {
      return { kind: "ephemeral", content: NOT_ALLOWED };
    }
    const file = this.fileRepo.findById(fileId);
    if (!file) {
      this.reviewRepo.delete(fileId);
      return { kind: "ephemeral", content: "This file no longer exists." };
    }
    const already = this.resolutionFor(file);
    if (already) return await this.resolveInPlace(fileId, file, already);

    return {
      kind: "confirm",
      prompt:
        `Reject **${file.fileName}** (${formatBytes(file.sizeBytes)})?\n` +
        "This permanently deletes the file and kills every link to it.",
    };
  }

  async confirmReject(
    fileId: string,
    actorDiscordId: string,
  ): Promise<ButtonOutcome> {
    if (!this.isAdmin(actorDiscordId)) {
      return { kind: "ephemeral", content: NOT_ALLOWED };
    }
    const file = this.fileRepo.findById(fileId);
    if (!file) {
      this.reviewRepo.delete(fileId);
      return { kind: "ephemeral", content: "This file no longer exists." };
    }
    if (file.deletedAt) {
      return { kind: "ephemeral", content: "Already deleted." };
    }
    // Tombstone is attributed to the admin's server account when they have
    // one (they may never have signed in to the web UI — then null = system).
    const actorUserId = this.identity.userIdForDiscord(actorDiscordId);
    await this.files.delete(fileId, actorUserId);
    this.log.info(
      { fileId, actorDiscordId, actorUserId },
      "file rejected via Discord",
    );

    const ref = this.reviewRepo.findByFileId(fileId);
    if (ref) {
      await this.closeMessage(
        ref,
        { ...file, deletedAt: new Date() },
        { kind: "deleted", byDiscordId: actorDiscordId },
      );
    }
    return { kind: "ephemeral", content: "File rejected and deleted." };
  }

  /**
   * Resolve the channel message the pressed button lives on. Returns an
   * `update` outcome so the interaction layer can edit that message directly
   * (no extra fetch); the repo row is closed here.
   */
  private async resolveInPlace(
    fileId: string,
    file: FileRow,
    resolution: ReviewResolution,
  ): Promise<ButtonOutcome> {
    const ownerName = (await this.fileRepo.ownerName(file.ownerId)) ?? "?";
    this.reviewRepo.delete(fileId);
    return {
      kind: "update",
      content: resolvedContent(file, ownerName, this.opts.baseUrl, resolution),
    };
  }
}
