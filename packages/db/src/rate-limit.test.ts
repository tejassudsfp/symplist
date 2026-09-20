import { describe, expect, it } from "vitest";
import { ManualClock } from "../../testing/src/contracts/db/manual-clock.ts";
import { DbError, DbRateLimitedError } from "./errors.ts";
import {
  createApiLane,
  createMigrationLane,
  createWorkerLane,
  D1_BUDGET,
  processLane,
  RateLane,
  TokenBucket,
  workerProcessRate,
} from "./rate-limit.ts";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("TokenBucket", () => {
  it("starts full, refills continuously and caps at capacity", async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket(2, 4, clock);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    expect(bucket.msUntil(1)).toBe(250);
    await clock.advance(250);
    expect(bucket.tryTake()).toBe(true);
    await clock.advance(10_000);
    expect(bucket.available()).toBe(2);
    expect(() => new TokenBucket(0, 1, clock)).toThrow(RangeError);
    expect(() => new TokenBucket(1, 0, clock)).toThrow(RangeError);
  });
});

describe("D1 budget (§3.1)", () => {
  it("keeps all runtimes within 3 req/s and the worker family within 1 req/s", () => {
    expect(
      D1_BUDGET.api.ratePerSecond + D1_BUDGET.worker.totalRequestsPerSecond,
    ).toBeLessThanOrEqual(D1_BUDGET.totalRequestsPerSecond);
    const family = D1_BUDGET.worker.familyConcurrency;
    expect(family).toBe(4 + 2 + 1);
    expect(family * workerProcessRate(family)).toBeLessThanOrEqual(1 + 1e-12);
    expect(() => workerProcessRate(0)).toThrow(RangeError);
  });

  it("configures the api, worker and migrations lanes", () => {
    const api = createApiLane();
    expect([api.name, api.ratePerSecond, api.burst]).toEqual(["api", 2, 10]);
    const worker = createWorkerLane();
    expect([worker.name, worker.ratePerSecond, worker.burst]).toEqual(["worker", 1 / 7, 4]);
    expect(createWorkerLane({ familyConcurrency: 10 }).ratePerSecond).toBeCloseTo(0.1);
    const migrations = createMigrationLane();
    expect([migrations.name, migrations.burst]).toEqual(["migrations", 1]);
  });

  it("shares one process-wide lane per kind", () => {
    expect(processLane("api")).toBe(processLane("api"));
    expect(processLane("worker")).not.toBe(processLane("api"));
  });
});

describe("api lane", () => {
  it("allows a burst of 10, then queues authenticated work at 2 req/s in FIFO order", async () => {
    const clock = new ManualClock();
    const lane = createApiLane({ clock });
    for (let index = 0; index < 10; index += 1) {
      await expect(lane.acquire("authenticated")).resolves.toEqual({ waitedMs: 0 });
    }
    const order: number[] = [];
    const waiters = [0, 1, 2].map((index) =>
      lane.acquire("authenticated").then((grant) => {
        order.push(index);
        return grant;
      }),
    );
    await clock.advance(499);
    expect(order).toEqual([]);
    await clock.advance(1);
    expect(order).toEqual([0]);
    await clock.advance(1_000);
    expect(order).toEqual([0, 1, 2]);
    const grants = await Promise.all(waiters);
    expect(grants.map((grant) => grant.waitedMs)).toEqual([500, 1_000, 1_500]);
  });

  it("caps unauthenticated work at 30% of the bucket and sheds it with rate.limited", async () => {
    const clock = new ManualClock();
    const lane = createApiLane({ clock });
    for (let index = 0; index < 3; index += 1) {
      await expect(lane.acquire("unauthenticated")).resolves.toEqual({ waitedMs: 0 });
    }
    const shed = await rejection(lane.acquire("unauthenticated"));
    expect(shed).toBeInstanceOf(DbRateLimitedError);
    expect((shed as DbRateLimitedError).reason).toBe("shed");
    expect((shed as DbRateLimitedError).code).toBe("rate.limited");
    expect((shed as DbRateLimitedError).retryAfterMs).toBeGreaterThan(0);
    // Authenticated work still has the remaining 7 tokens.
    for (let index = 0; index < 7; index += 1) {
      await expect(lane.acquire("authenticated")).resolves.toEqual({ waitedMs: 0 });
    }
    // The unauthenticated sub-bucket refills at 0.6 req/s.
    await clock.advance(1_700);
    await expect(lane.acquire("unauthenticated")).resolves.toEqual({ waitedMs: 0 });
  });

  it("sheds unauthenticated work first while authenticated work is waiting", async () => {
    const clock = new ManualClock();
    const lane = createApiLane({ clock });
    for (let index = 0; index < 10; index += 1) await lane.acquire("authenticated");
    const queued = lane.acquire("authenticated");
    await clock.advance(10);
    expect(lane.waiting).toBe(1);
    await expect(lane.acquire("unauthenticated")).rejects.toMatchObject({ reason: "shed" });
    await clock.advance(1_000);
    await expect(queued).resolves.toMatchObject({ waitedMs: 500 });
  });

  it("refuses authenticated work whose wait would exceed the lane limit", async () => {
    const clock = new ManualClock();
    const lane = createApiLane({ clock, maxWaitMs: 1_000 });
    for (let index = 0; index < 10; index += 1) await lane.acquire();
    const pending = [lane.acquire(), lane.acquire()];
    const refused = await rejection(lane.acquire());
    expect(refused).toMatchObject({
      code: "rate.limited",
      reason: "queue_timeout",
      retryAfterMs: 1_500,
    });
    await clock.advance(1_000);
    await Promise.all(pending);
  });

  it("removes aborted waiters from the queue", async () => {
    const clock = new ManualClock();
    const lane = new RateLane({
      name: "test",
      ratePerSecond: 1,
      burst: 1,
      maxWaitMs: 60_000,
      clock,
    });
    await lane.acquire();
    const controller = new AbortController();
    const aborted = lane.acquire("authenticated", controller.signal);
    const next = lane.acquire();
    controller.abort();
    const error = await rejection(aborted);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("db.aborted");
    await clock.advance(1_000);
    await expect(next).resolves.toMatchObject({ waitedMs: 1_000 });
    const already = new AbortController();
    already.abort();
    await expect(lane.acquire("authenticated", already.signal)).rejects.toMatchObject({
      code: "db.aborted",
    });
  });
});

describe("worker lane", () => {
  it("allows a burst of 4 per process, then one request every 7 seconds", async () => {
    const clock = new ManualClock();
    const lane = createWorkerLane({ clock });
    for (let index = 0; index < 4; index += 1) await lane.acquire();
    let granted = false;
    const next = lane.acquire().then(() => {
      granted = true;
    });
    await clock.advance(6_999);
    expect(granted).toBe(false);
    await clock.advance(1);
    await next;
    expect(granted).toBe(true);
  });

  it("treats unauthenticated priority like authenticated work (no sub-lane)", async () => {
    const clock = new ManualClock();
    const lane = createWorkerLane({ clock });
    for (let index = 0; index < 4; index += 1) {
      await expect(lane.acquire("unauthenticated")).resolves.toEqual({ waitedMs: 0 });
    }
  });
});
