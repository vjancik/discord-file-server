import { describe, expect, test } from "bun:test";
import { SingleFlight } from "./single-flight";

/** Manually advanced clock so retention is tested without real timers. */
function testClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("SingleFlight", () => {
  test("concurrent callers share one execution and one result", async () => {
    const flight = new SingleFlight<string>(60_000);
    let runs = 0;
    let release!: (v: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const fn = () => {
      runs++;
      return gate;
    };

    const first = flight.run("upload-1", fn);
    const second = flight.run("upload-1", fn);
    release("published");

    expect(await first).toBe("published");
    expect(await second).toBe("published");
    expect(runs).toBe(1);
  });

  test("retains a successful result for late retries within retainMs", async () => {
    const clock = testClock();
    const flight = new SingleFlight<string>(60_000, clock.now);
    let runs = 0;

    await flight.run("upload-1", async () => {
      runs++;
      return "published";
    });
    clock.advance(59_999);
    const retried = await flight.run("upload-1", async () => {
      runs++;
      return "second-run";
    });

    expect(retried).toBe("published");
    expect(runs).toBe(1);
  });

  test("evicts a retained result after retainMs", async () => {
    const clock = testClock();
    const flight = new SingleFlight<string>(60_000, clock.now);

    await flight.run("upload-1", async () => "first");
    clock.advance(60_000);
    const rerun = await flight.run("upload-1", async () => "second");

    expect(rerun).toBe("second");
  });

  test("a failure is not retained: every waiter gets the error, then the key is free", async () => {
    const flight = new SingleFlight<string>(60_000);
    const boom = new Error("finalize failed");
    let release!: (err: Error) => void;
    const gate = new Promise<string>((_, rejectGate) => {
      release = rejectGate;
    });

    const first = flight.run("upload-1", () => gate);
    const second = flight.run("upload-1", () => gate);
    release(boom);

    expect(first).rejects.toBe(boom);
    expect(second).rejects.toBe(boom);
    expect(await flight.run("upload-1", async () => "retry-ok")).toBe(
      "retry-ok",
    );
  });

  test("different keys run independently", async () => {
    const flight = new SingleFlight<string>(60_000);
    const a = await flight.run("upload-a", async () => "a");
    const b = await flight.run("upload-b", async () => "b");
    expect(a).toBe("a");
    expect(b).toBe("b");
  });
});
