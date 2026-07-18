export interface StagingReservation {
  /** Full declared upload size — reserved up front, not the bytes on disk so far. */
  sizeBytes: number;
  ownerId: string;
}

/**
 * In-memory ledger of in-flight tus uploads: upload id → full declared size.
 *
 * Correct only because the app is a single Bun process (Next standalone);
 * a second replica would admit uploads this instance can't see. That is the
 * deployment model (PRD §7) — revisit if it ever changes.
 *
 * Lifecycle: reserved in `onUploadCreate` (before any bytes land), released
 * when finalize completes/fails, when the client terminates the upload
 * (tus DELETE), or when GC/eviction removes the staging files. Because a
 * resumed upload PATCHes an existing URL and never re-enters
 * `onUploadCreate`, the ledger is rebuilt at boot from FileStore's
 * `<id>.json` sidecars and reconciled against the staging dir hourly — a
 * missed release heals instead of leaking phantom pressure forever.
 */
export class StagingLedger {
  private readonly reservations = new Map<string, StagingReservation>();

  reserve(id: string, sizeBytes: number, ownerId: string): void {
    this.reservations.set(id, { sizeBytes, ownerId });
  }

  /** @returns true if a reservation existed. Safe to call twice. */
  release(id: string): boolean {
    return this.reservations.delete(id);
  }

  has(id: string): boolean {
    return this.reservations.has(id);
  }

  ids(): string[] {
    return [...this.reservations.keys()];
  }

  get count(): number {
    return this.reservations.size;
  }

  totalReserved(): number {
    let total = 0;
    for (const r of this.reservations.values()) total += r.sizeBytes;
    return total;
  }

  /** In-flight bytes for one user — folded into their quota check (TOCTOU fix). */
  reservedByOwner(ownerId: string): number {
    let total = 0;
    for (const r of this.reservations.values()) {
      if (r.ownerId === ownerId) total += r.sizeBytes;
    }
    return total;
  }

  clear(): void {
    this.reservations.clear();
  }
}
