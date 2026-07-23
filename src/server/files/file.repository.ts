import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  isNull,
  lte,
  sum,
} from "drizzle-orm";
import type { Db } from "@/db/client";
import { type FileRow, files, type NewFileRow } from "@/db/schema";

/**
 * Data access for the files table. "Live" means not tombstoned
 * (deletedAt IS NULL); deleted rows are kept for admin accountability.
 */
export class FileRepository {
  constructor(private readonly db: Db) {}

  insert(row: NewFileRow): FileRow {
    const [inserted] = this.db.insert(files).values(row).returning().all();
    return inserted;
  }

  findLiveById(id: string): FileRow | undefined {
    return this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), isNull(files.deletedAt)))
      .get();
  }

  findLiveByShortCode(shortCode: string): FileRow | undefined {
    return this.db
      .select()
      .from(files)
      .where(and(eq(files.shortCode, shortCode), isNull(files.deletedAt)))
      .get();
  }

  /** Any row, tombstoned or not — for admin views and delete authorization. */
  findById(id: string): FileRow | undefined {
    return this.db.select().from(files).where(eq(files.id, id)).get();
  }

  listLiveByOwner(ownerId: string): FileRow[] {
    return this.db
      .select()
      .from(files)
      .where(and(eq(files.ownerId, ownerId), isNull(files.deletedAt)))
      .orderBy(desc(files.createdAt))
      .all();
  }

  listLiveByOwnerOldestFirst(ownerId: string): FileRow[] {
    return this.db
      .select()
      .from(files)
      .where(and(eq(files.ownerId, ownerId), isNull(files.deletedAt)))
      .orderBy(asc(files.createdAt))
      .all();
  }

  /** Review queue: live pending files, oldest first, with owner loaded. */
  async listPendingWithOwner() {
    return await this.db.query.files.findMany({
      where: and(eq(files.status, "pending"), isNull(files.deletedAt)),
      orderBy: asc(files.createdAt),
      with: { owner: true },
    });
  }

  /** Admin browser: everything including tombstones, newest first, with owner. */
  async listAllWithOwner() {
    return await this.db.query.files.findMany({
      orderBy: desc(files.createdAt),
      with: { owner: true, deletedBy: true },
    });
  }

  sumLiveSizeByOwner(ownerId: string): number {
    const row = this.db
      .select({ total: sum(files.sizeBytes) })
      .from(files)
      .where(and(eq(files.ownerId, ownerId), isNull(files.deletedAt)))
      .get();
    return Number(row?.total ?? 0);
  }

  totalLiveBytes(): number {
    const row = this.db
      .select({ total: sum(files.sizeBytes) })
      .from(files)
      .where(isNull(files.deletedAt))
      .get();
    return Number(row?.total ?? 0);
  }

  /** Display name of a user (for OG descriptions). */
  async ownerName(userId: string): Promise<string | undefined> {
    const row = await this.db.query.user.findFirst({
      where: (u, { eq: whereEq }) => whereEq(u.id, userId),
      columns: { name: true },
    });
    return row?.name;
  }

  countLiveByOwner(ownerId: string): number {
    const row = this.db
      .select({ n: countDistinct(files.id) })
      .from(files)
      .where(and(eq(files.ownerId, ownerId), isNull(files.deletedAt)))
      .get();
    return row?.n ?? 0;
  }

  /** Quota divisor: users currently holding ≥ 1 live file (PRD §7). */
  countActiveUsers(): number {
    const row = this.db
      .select({ n: countDistinct(files.ownerId) })
      .from(files)
      .where(isNull(files.deletedAt))
      .get();
    return row?.n ?? 0;
  }

  /** Tombstone a row: bytes are removed by the caller, the record stays. null actor = system (expiry). */
  markDeleted(
    id: string,
    deletedById: string | null,
    deletedAt = new Date(),
  ): void {
    this.db
      .update(files)
      .set({ deletedAt, deletedById })
      .where(eq(files.id, id))
      .run();
  }

  approve(id: string): void {
    this.db
      .update(files)
      .set({ status: "approved" })
      .where(eq(files.id, id))
      .run();
  }

  /** Live files whose expiresAt has passed — input to the expiry cleanup job. */
  listExpired(now = new Date()): FileRow[] {
    return this.db
      .select()
      .from(files)
      .where(and(isNull(files.deletedAt), lte(files.expiresAt, now)))
      .all();
  }
}
