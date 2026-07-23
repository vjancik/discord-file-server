import { describe, expect, test } from "bun:test";
import { formatSpeed, SpeedEstimator } from "./upload-speed";

describe("SpeedEstimator", () => {
  test("returns null on the first sample", () => {
    const est = new SpeedEstimator();
    expect(est.sample(0, 0)).toBeNull();
  });

  test("converges to a steady transfer rate", () => {
    const est = new SpeedEstimator();
    // 1 MB every 500 ms = 2 MB/s
    let speed: number | null = null;
    for (let i = 0; i <= 20; i++) {
      speed = est.sample(i * 1_000_000, i * 500);
    }
    expect(speed).not.toBeNull();
    expect(speed as number).toBeGreaterThan(1_900_000);
    expect(speed as number).toBeLessThan(2_100_000);
  });

  test("smooths out bursty progress instead of tracking spikes", () => {
    const est = new SpeedEstimator();
    est.sample(0, 0);
    est.sample(1_000_000, 1000); // 1 MB/s baseline
    est.sample(2_000_000, 2000);
    // Single 100 ms burst at 10 MB/s must not swing the average to 10 MB/s.
    const speed = est.sample(3_000_000, 2100);
    expect(speed as number).toBeLessThan(2_000_000);
  });

  test("ignores samples with no time elapsed", () => {
    const est = new SpeedEstimator();
    est.sample(0, 0);
    const speed = est.sample(1_000_000, 1000);
    expect(est.sample(2_000_000, 1000)).toBe(speed);
  });

  test("restarts estimation when bytes go backwards", () => {
    const est = new SpeedEstimator();
    est.sample(0, 0);
    expect(est.sample(5_000_000, 1000)).not.toBeNull();
    // A retry rewound progress — stale average must not survive.
    expect(est.sample(1_000_000, 2000)).toBeNull();
    expect(est.sample(2_000_000, 3000)).toBe(1_000_000);
  });

  test("reset clears all state", () => {
    const est = new SpeedEstimator();
    est.sample(0, 0);
    est.sample(1_000_000, 1000);
    est.reset();
    expect(est.sample(50_000_000, 2000)).toBeNull();
  });
});

describe("formatSpeed", () => {
  test("formats with decimal units and /s suffix", () => {
    expect(formatSpeed(500)).toBe("500 B/s");
    expect(formatSpeed(2_400_000)).toBe("2.4 MB/s");
    expect(formatSpeed(1_250_000_000)).toBe("1.3 GB/s");
  });
});
