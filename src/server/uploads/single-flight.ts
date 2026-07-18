/**
 * Deduplicates concurrent async work by key: callers that arrive while the
 * work is in flight await the same promise, and a successful result is
 * retained for `retainMs` so late callers get it too. Failures are dropped
 * immediately so the key can be retried.
 *
 * Exists for tus finalize: @tus/server releases the per-upload lock before
 * onUploadFinish runs, so a retried final PATCH (lost response, proxy
 * timeout) can otherwise start a second finalize against the same staging
 * file — publishing duplicate rows or copying a half-unlinked source.
 */
export class SingleFlight<T> {
  private readonly entries = new Map<
    string,
    { promise: Promise<T>; expiresAt: number | null }
  >();

  constructor(
    private readonly retainMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  run(key: string, fn: () => Promise<T>): Promise<T> {
    this.sweep();
    const existing = this.entries.get(key);
    if (existing) return existing.promise;

    const entry: { promise: Promise<T>; expiresAt: number | null } = {
      expiresAt: null,
      promise: fn().then(
        (value) => {
          entry.expiresAt = this.now() + this.retainMs;
          return value;
        },
        (err) => {
          this.entries.delete(key);
          throw err;
        },
      ),
    };
    this.entries.set(key, entry);
    return entry.promise;
  }

  /** Settled-and-expired entries are evicted lazily on the next run(). */
  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
