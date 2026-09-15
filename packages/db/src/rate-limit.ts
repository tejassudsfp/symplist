import type { RequestPriority } from "./client.ts";
import { DbError, DbRateLimitedError } from "./errors.ts";

/** Time source for buckets, circuits and backoff; tests substitute a manual clock. */
export interface Clock {
  now(): number;
  /** Resolves after `ms`; rejects when `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortedError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortedError());
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export function abortedError(): DbError {
  return new DbError("db.aborted", "D1 request aborted by the caller");
}

/** A token bucket refilled continuously at `ratePerSecond` up to `capacity`. */
export class TokenBucket {
  readonly capacity: number;
  readonly ratePerSecond: number;
  private tokens: number;
  private refilledAt: number;
  private readonly clock: Clock;

  constructor(capacity: number, ratePerSecond: number, clock: Clock) {
    if (!(capacity >= 1) || !(ratePerSecond > 0)) {
      throw new RangeError("Token bucket needs capacity >= 1 and a positive rate");
    }
    this.capacity = capacity;
    this.ratePerSecond = ratePerSecond;
    this.clock = clock;
    this.tokens = capacity;
    this.refilledAt = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.refilledAt);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.ratePerSecond) / 1000);
    this.refilledAt = now;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until `count` tokens are available at the current refill rate. */
  msUntil(count = 1): number {
    this.refill();
    if (this.tokens >= count) return 0;
    return Math.ceil(((count - this.tokens) * 1000) / this.ratePerSecond);
  }
}

export interface RateLaneOptions {
  /** Lane id used in counters, for example `api` or `worker`. */
  readonly name: string;
  readonly ratePerSecond: number;
  readonly burst: number;
  /**
   * Share of the bucket unauthenticated work may use (0 to 1). When set, unauthenticated calls also
   * draw from a sub-bucket of `burst × share` tokens refilled at `rate × share`, never queue, and are
   * shed with `rate.limited` whenever tokens are short or authenticated work is waiting.
   */
  readonly unauthenticatedShare?: number;
  /** Authenticated callers are refused with `rate.limited` when their wait would exceed this. */
  readonly maxWaitMs: number;
  readonly clock?: Clock;
}

export interface LaneGrant {
  /** Time spent waiting for a token. */
  readonly waitedMs: number;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

/** One D1 request lane: a token bucket with a FIFO queue for authenticated work (§3.1). */
export class RateLane {
  readonly name: string;
  readonly ratePerSecond: number;
  readonly burst: number;
  readonly maxWaitMs: number;
  private readonly clock: Clock;
  private readonly bucket: TokenBucket;
  private readonly unauthenticated: TokenBucket | undefined;
  private readonly queue: Waiter[] = [];
  private pumping = false;

  constructor(options: RateLaneOptions) {
    this.name = options.name;
    this.ratePerSecond = options.ratePerSecond;
    this.burst = options.burst;
    this.maxWaitMs = options.maxWaitMs;
    this.clock = options.clock ?? systemClock;
    this.bucket = new TokenBucket(options.burst, options.ratePerSecond, this.clock);
    const share = options.unauthenticatedShare;
    if (share !== undefined) {
      if (!(share > 0 && share < 1)) throw new RangeError("unauthenticatedShare must be in (0, 1)");
      this.unauthenticated = new TokenBucket(
        Math.max(1, Math.floor(options.burst * share)),
        options.ratePerSecond * share,
        this.clock,
      );
    }
  }

  /** Callers currently queued for a token. */
  get waiting(): number {
    return this.queue.length;
  }

  /** Waits for a token (authenticated) or takes one immediately or sheds (unauthenticated). */
  async acquire(
    priority: RequestPriority = "authenticated",
    signal?: AbortSignal,
  ): Promise<LaneGrant> {
    if (signal?.aborted) throw abortedError();
    const started = this.clock.now();

    if (priority === "unauthenticated" && this.unauthenticated) {
      const sub = this.unauthenticated;
      if (this.queue.length > 0 || this.bucket.available() < 1 || sub.available() < 1) {
        const retryAfter = Math.max(this.bucket.msUntil(this.queue.length + 1), sub.msUntil(1), 1);
        throw new DbRateLimitedError("shed", retryAfter);
      }
      this.bucket.tryTake();
      sub.tryTake();
      return { waitedMs: 0 };
    }

    if (this.queue.length === 0 && this.bucket.tryTake()) return { waitedMs: 0 };

    const estimate = this.bucket.msUntil(this.queue.length + 1);
    if (estimate > this.maxWaitMs) throw new DbRateLimitedError("queue_timeout", estimate);

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        settled: false,
        resolve: () => {
          waiter.settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          waiter.settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const position = this.queue.indexOf(waiter);
        if (position !== -1) this.queue.splice(position, 1);
        if (!waiter.settled) waiter.reject(abortedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      this.pump();
    });
    return { waitedMs: this.clock.now() - started };
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    const run = async () => {
      try {
        while (this.queue.length > 0) {
          if (this.bucket.tryTake()) {
            this.queue.shift()?.resolve();
            continue;
          }
          await this.clock.sleep(this.bucket.msUntil(1));
        }
      } finally {
        this.pumping = false;
      }
    };
    void run();
  }
}

/** The global D1 request budget (§3.1, decision R3). */
export const D1_BUDGET = Object.freeze({
  /** All runtimes together, until the live suite proves separate tokens have separate limits. */
  totalRequestsPerSecond: 3,
  api: Object.freeze({ ratePerSecond: 2, burst: 10, unauthenticatedShare: 0.3, maxWaitMs: 5_000 }),
  worker: Object.freeze({
    totalRequestsPerSecond: 1,
    burst: 4,
    /** Sum of the D1 queue family's `concurrencyLimit` values (`d1` 4 + `d1-git` 2 + `reminder-scan` 1). */
    familyConcurrency: 7,
    maxWaitMs: 120_000,
  }),
  migrations: Object.freeze({ ratePerSecond: 1, burst: 1, maxWaitMs: 60_000 }),
});

/** Per-process worker rate: `1 req/s ÷ N`, where N is the D1 queue family's total concurrency. */
export function workerProcessRate(
  familyConcurrency: number = D1_BUDGET.worker.familyConcurrency,
): number {
  if (!Number.isInteger(familyConcurrency) || familyConcurrency < 1) {
    throw new RangeError("familyConcurrency must be a positive integer");
  }
  return D1_BUDGET.worker.totalRequestsPerSecond / familyConcurrency;
}

/** The api (Render) lane: 2 req/s, burst 10, unauthenticated work capped at 30% and shed first. */
export function createApiLane(options: { clock?: Clock; maxWaitMs?: number } = {}): RateLane {
  return new RateLane({
    name: "api",
    ratePerSecond: D1_BUDGET.api.ratePerSecond,
    burst: D1_BUDGET.api.burst,
    unauthenticatedShare: D1_BUDGET.api.unauthenticatedShare,
    maxWaitMs: options.maxWaitMs ?? D1_BUDGET.api.maxWaitMs,
    clock: options.clock,
  });
}

/** One worker process's lane: `1 ÷ N` req/s with a burst of 4. */
export function createWorkerLane(
  options: { clock?: Clock; familyConcurrency?: number; maxWaitMs?: number } = {},
): RateLane {
  return new RateLane({
    name: "worker",
    ratePerSecond: workerProcessRate(options.familyConcurrency),
    burst: D1_BUDGET.worker.burst,
    maxWaitMs: options.maxWaitMs ?? D1_BUDGET.worker.maxWaitMs,
    clock: options.clock,
  });
}

/** The migrations lane: sequential, one request at a time. */
export function createMigrationLane(options: { clock?: Clock; maxWaitMs?: number } = {}): RateLane {
  return new RateLane({
    name: "migrations",
    ratePerSecond: D1_BUDGET.migrations.ratePerSecond,
    burst: D1_BUDGET.migrations.burst,
    maxWaitMs: options.maxWaitMs ?? D1_BUDGET.migrations.maxWaitMs,
    clock: options.clock,
  });
}

export type LaneKind = "api" | "worker" | "migrations";

const processLanes = new Map<LaneKind, RateLane>();

/**
 * The process-wide lane of a kind, so every client in a process shares one bucket. The worker lane
 * uses the default queue family size; pass a `RateLane` to the client to override.
 */
export function processLane(kind: LaneKind): RateLane {
  let lane = processLanes.get(kind);
  if (!lane) {
    lane =
      kind === "api"
        ? createApiLane()
        : kind === "worker"
          ? createWorkerLane()
          : createMigrationLane();
    processLanes.set(kind, lane);
  }
  return lane;
}
