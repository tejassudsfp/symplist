import { describe, expect, it } from "vitest";
import { defaultFakeClockStart, FakeClock } from "./clock.ts";

describe("FakeClock", () => {
  it("starts at a fixed instant and only moves when told to", async () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(defaultFakeClockStart);
    expect(clock.date().toISOString()).toBe("2026-09-15T09:00:00.000Z");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(clock.now()).toBe(defaultFakeClockStart);
    await clock.advance(1500);
    expect(clock.now()).toBe(defaultFakeClockStart + 1500);
    expect(clock.nowFn()).toBe(clock.now());
  });

  it("accepts a Date start and refuses to move backwards or by invalid amounts", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    await expect(clock.set(Date.UTC(2025, 0, 1))).rejects.toThrow(RangeError);
    await expect(clock.advance(-1)).rejects.toThrow(RangeError);
    await expect(clock.advance(Number.NaN)).rejects.toThrow(RangeError);
    expect(() => new FakeClock(Number.NaN)).toThrow(RangeError);
    await clock.set(new Date("2026-01-02T00:00:00Z"));
    expect(clock.date().toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("runs due timers in deadline order with the clock set to each deadline", async () => {
    const clock = new FakeClock(0);
    const fired: Array<[string, number]> = [];
    clock.setTimeout(() => fired.push(["b", clock.now()]), 200);
    clock.setTimeout(() => fired.push(["a", clock.now()]), 100);
    clock.setTimeout(() => fired.push(["c", clock.now()]), 100);
    const cancelled = clock.setTimeout(() => fired.push(["x", clock.now()]), 150);
    clock.clearTimeout(cancelled);

    await clock.advance(150);
    expect(fired).toEqual([
      ["a", 100],
      ["c", 100],
    ]);
    expect(clock.now()).toBe(150);
    await clock.advance(100);
    expect(fired.at(-1)).toEqual(["b", 200]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("repeats intervals and settles promise chains started by callbacks", async () => {
    const clock = new FakeClock(0);
    const ticks: number[] = [];
    const handle = clock.setInterval(() => {
      void Promise.resolve().then(() => ticks.push(clock.now()));
    }, 60_000);
    await clock.advance(3 * 60_000);
    expect(ticks).toEqual([60_000, 120_000, 180_000]);
    clock.clearInterval(handle);
    await clock.advance(60_000);
    expect(ticks).toHaveLength(3);
    expect(() => clock.setInterval(() => undefined, 0)).toThrow(RangeError);
  });

  it("resolves sleeps and runAll drains one-shot timers", async () => {
    const clock = new FakeClock(0);
    let woke = false;
    const sleeping = clock.sleep(30_000).then(() => {
      woke = true;
    });
    clock.setTimeout(() => undefined, 90_000);
    await clock.runAll();
    await sleeping;
    expect(woke).toBe(true);
    expect(clock.now()).toBe(90_000);

    clock.setInterval(() => undefined, 1000);
    await expect(clock.runAll()).rejects.toThrow(/interval/);
  });
});
