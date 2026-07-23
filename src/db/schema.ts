import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const FILE_KINDS = ["video", "image", "audio", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_STATUSES = ["pending", "approved"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/**
 * Outcome of the finalize metadata-strip pipeline, recorded per file:
 * - `stripped`: a strategy ran and removed the metadata channel (images,
 *   video/audio, PDF, Office).
 * - `none`: the format has no embedded-metadata channel to begin with — plain
 *   text, source code, config (the `NO_METADATA_EXTS` fast path). Nothing to
 *   remove, so nothing was.
 * - `possible`: the file may still carry PII — stripping was disabled by the
 *   user's toggle, the format is uncleanable (tar/7z/legacy Office/unknown
 *   binary), or it's an archive whose container we cleaned but whose contents
 *   we never touch (zip).
 *
 * `none` is decided server-side from the extension allowlist only; the upload
 * page's content-sniff (which can also treat an unknown extension as text) is
 * a cosmetic warning-suppressor and never promotes a file to `none` here.
 * Not surfaced in the UI yet.
 */
export const METADATA_STATUSES = ["stripped", "none", "possible"] as const;
export type MetadataStatus = (typeof METADATA_STATUSES)[number];

/**
 * One row per upload. Rows survive deletion as tombstones for admin
 * accountability (PRD §3): `deletedAt IS NOT NULL` means the bytes are gone
 * but the record isn't. All "live file" queries must filter on deletedAt.
 */
export const files = sqliteTable(
  "files",
  {
    /** 128-bit crypto-random base64url — the capability credential (PRD §8). */
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Sanitized original filename, extension included; last path segment of /f/ URLs. */
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    kind: text("kind", { enum: FILE_KINDS }).notNull(),
    status: text("status", { enum: FILE_STATUSES })
      .notNull()
      .default("pending"),
    shortCode: text("short_code").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: integer("duration_seconds"),
    /** Path relative to STORAGE_DIR, e.g. "<id>/thumb.jpg"; null = no thumbnail. */
    thumbnailPath: text("thumbnail_path"),
    /** Outcome of the metadata-strip pipeline; see {@link METADATA_STATUSES}. */
    metadataStatus: text("metadata_status", { enum: METADATA_STATUSES })
      .notNull()
      .default("possible"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    deletedById: text("deleted_by_id").references(() => user.id),
  },
  (table) => [
    uniqueIndex("files_short_code_idx").on(table.shortCode),
    index("files_owner_created_idx").on(table.ownerId, table.createdAt),
    index("files_status_idx").on(table.status),
  ],
);

/**
 * Source metadata for files created by the bot's /embed_video command
 * (docs/embed-video.md, second iteration): the yt-dlp probe's title,
 * description and canonical page URL. Written by the bot right after the tus
 * upload finalizes; read by the /s OG page and the /v watch page. Files
 * uploaded through the web UI have no row here.
 */
export const embedSources = sqliteTable("embed_sources", {
  fileId: text("file_id")
    .primaryKey()
    .references(() => files.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  sourceUrl: text("source_url").notNull(),
  /** Source view count at embed time; null when the platform doesn't expose one. */
  viewCount: integer("view_count"),
  /** Source publish date; null when unknown. */
  uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }),
});

/**
 * Open admin-review announcements posted to Discord by the bot process
 * (src/bot). One row per pending file whose message awaits an Approve/Reject
 * decision; rows are deleted once resolved (the Discord message itself is the
 * durable history). The web app never writes this table.
 */
export const discordReviewMessages = sqliteTable("discord_review_messages", {
  fileId: text("file_id")
    .primaryKey()
    .references(() => files.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  postedAt: integer("posted_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

/**
 * Single-use ids of accepted upload service tokens (docs/embed-auth.md).
 * A jti is consumed when a token-authenticated tus upload is created; rows
 * expire with the token and are pruned opportunistically on insert. Shared
 * DB (not memory) so replay protection holds across app restarts and, later,
 * multiple app nodes.
 */
export const serviceTokenJtis = sqliteTable("service_token_jtis", {
  jti: text("jti").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Opt-in: delete own oldest files to make room when an upload exceeds quota. */
  autoDeleteOldest: integer("auto_delete_oldest", { mode: "boolean" })
    .notNull()
    .default(false),
  /** "Don't show this again" on the delete-confirmation dialog (global). */
  skipDeleteConfirm: integer("skip_delete_confirm", { mode: "boolean" })
    .notNull()
    .default(false),
  /** Strip embedded metadata (EXIF GPS, device tags…) from photos, video and audio. */
  stripMediaMetadata: integer("strip_media_metadata", { mode: "boolean" })
    .notNull()
    .default(true),
  /** Strip author/account metadata from documents (PDF, Office) and zip containers. */
  stripDocumentMetadata: integer("strip_document_metadata", { mode: "boolean" })
    .notNull()
    .default(true),
});

export const filesRelations = relations(files, ({ one }) => ({
  owner: one(user, { fields: [files.ownerId], references: [user.id] }),
  deletedBy: one(user, { fields: [files.deletedById], references: [user.id] }),
}));

export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
export type UserSettingsRow = typeof userSettings.$inferSelect;
export type EmbedSourceRow = typeof embedSources.$inferSelect;
