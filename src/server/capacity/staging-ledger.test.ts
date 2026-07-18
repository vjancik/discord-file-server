import { describe, expect, test } from "bun:test";
import { StagingLedger } from "./staging-ledger";

describe("StagingLedger", () => {
  test("tracks totals and per-owner reservations", () => {
    const ledger = new StagingLedger();
    ledger.reserve("a", 100, "alice");
    ledger.reserve("b", 250, "bob");
    ledger.reserve("c", 50, "alice");

    expect(ledger.count).toBe(3);
    expect(ledger.totalReserved()).toBe(400);
    expect(ledger.reservedByOwner("alice")).toBe(150);
    expect(ledger.reservedByOwner("nobody")).toBe(0);
    expect(ledger.ids().sort()).toEqual(["a", "b", "c"]);
  });

  test("release is idempotent and reports whether an entry existed", () => {
    const ledger = new StagingLedger();
    ledger.reserve("a", 100, "alice");
    expect(ledger.release("a")).toBe(true);
    expect(ledger.release("a")).toBe(false);
    expect(ledger.totalReserved()).toBe(0);
  });

  test("re-reserving an id overwrites instead of double-counting", () => {
    const ledger = new StagingLedger();
    ledger.reserve("a", 100, "alice");
    ledger.reserve("a", 300, "alice");
    expect(ledger.totalReserved()).toBe(300);
  });
});
