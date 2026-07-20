import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { type EmbedSourceRow, embedSources } from "@/db/schema";

/** Bounds on untrusted yt-dlp metadata; the full text is never needed beyond these. */
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 10_000;
const MAX_URL = 2_000;

export interface EmbedSourceInput {
  title: string;
  description: string | null;
  sourceUrl: string;
  viewCount: number | null;
  uploadedAt: Date | null;
}

/**
 * Source metadata for /embed_video files (title, description, external page
 * URL). Written by the bot after upload; read by the /s OG page and the /v
 * watch page. Rows cascade away with their file.
 */
export class EmbedSourceRepository {
  constructor(private readonly db: Db) {}

  save(fileId: string, input: EmbedSourceInput): void {
    const row = {
      fileId,
      title: input.title.slice(0, MAX_TITLE),
      description: input.description?.slice(0, MAX_DESCRIPTION) || null,
      sourceUrl: input.sourceUrl.slice(0, MAX_URL),
      viewCount:
        input.viewCount !== null && Number.isFinite(input.viewCount)
          ? Math.max(0, Math.trunc(input.viewCount))
          : null,
      uploadedAt: input.uploadedAt,
    };
    this.db
      .insert(embedSources)
      .values(row)
      .onConflictDoUpdate({ target: embedSources.fileId, set: row })
      .run();
  }

  get(fileId: string): EmbedSourceRow | undefined {
    return this.db
      .select()
      .from(embedSources)
      .where(eq(embedSources.fileId, fileId))
      .get();
  }
}
