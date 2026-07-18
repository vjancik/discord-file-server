import { formatBytes } from "./units";

// Same smoothing half-life Uppy's status bar uses for its ETA, so the speed
// we display moves in step with the "time left" shown next to it.
const HALF_LIFE_MS = 2000;

/**
 * Exponential-moving-average estimator for upload speed. Feed it cumulative
 * uploaded bytes as progress events arrive; it returns a smoothed bytes/sec
 * that doesn't jitter with the burstiness of individual PATCH requests.
 */
export class SpeedEstimator {
  #prevBytes: number | null = null;
  #prevTime = 0;
  #speed: number | null = null;

  /** Returns smoothed bytes/sec, or null until enough data has arrived. */
  sample(totalBytes: number, nowMs: number): number | null {
    if (this.#prevBytes === null) {
      this.#prevBytes = totalBytes;
      this.#prevTime = nowMs;
      return null;
    }
    const dtMs = nowMs - this.#prevTime;
    if (dtMs <= 0) return this.#speed;
    const deltaBytes = totalBytes - this.#prevBytes;
    this.#prevBytes = totalBytes;
    this.#prevTime = nowMs;
    if (deltaBytes < 0) {
      // Bytes went backwards (a retry restarted a chunk, or a file was
      // removed) — the old average is meaningless, start over.
      this.#speed = null;
      return null;
    }
    const instant = (deltaBytes * 1000) / dtMs;
    const alpha = 1 - 2 ** (-dtMs / HALF_LIFE_MS);
    this.#speed =
      this.#speed === null
        ? instant
        : this.#speed + alpha * (instant - this.#speed);
    return this.#speed;
  }

  reset(): void {
    this.#prevBytes = null;
    this.#prevTime = 0;
    this.#speed = null;
  }
}

/** Human-readable transfer rate, e.g. "2.4 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}
