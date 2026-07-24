import { describe, expect, test } from "bun:test";
import { usableFreeBytes } from "./disk";

describe("usableFreeBytes", () => {
  test("normal ext4-style volume: exact bavail * bsize", () => {
    // 61058895 blocks * 4096 bytes ≈ 250 GB
    expect(usableFreeBytes(BigInt(61058895), BigInt(4096))).toBe(
      61058895 * 4096,
    );
  });

  test("mergerfs: large product that overflows JS number stays positive", () => {
    // A union pool can report bavail/bsize whose product exceeds
    // Number.MAX_SAFE_INTEGER. Must never come back negative (the original bug).
    const huge = usableFreeBytes(BigInt("9007199254740993"), BigInt(4096));
    expect(huge).toBeGreaterThan(0);
    expect(huge).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("inconsistent counts producing a non-positive product floor to 0", () => {
    expect(usableFreeBytes(BigInt(0), BigInt(4096))).toBe(0);
  });

  test("result is always a finite, non-negative number", () => {
    const cases: Array<[string, number]> = [
      ["1000000000000", 1024],
      ["500", 1048576],
      ["9999999999999999", 8192],
    ];
    for (const [bavail, bsize] of cases) {
      const bytes = usableFreeBytes(BigInt(bavail), BigInt(bsize));
      expect(Number.isFinite(bytes)).toBe(true);
      expect(bytes).toBeGreaterThanOrEqual(0);
      expect(bytes).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
  });
});
