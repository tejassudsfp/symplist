/** Anything that tells the time in UTC epoch milliseconds. */
export interface Clock {
  now(): number;
}

export interface FakeTimerHandle {
  readonly id: number;
}

interface ScheduledTimer {
  readonly id: number;
  dueAt: number;
  readonly intervalMs: number | null;
  readonly callback: () => void;
  readonly order: number;
}

/** 2026-09-15T09:00:00Z, the date the build's stack was verified. */
export const defaultFakeClockStart = Date.UTC(2026, 8, 15, 9, 0, 0);

async function drainMicrotasks(): Promise<void> {
  // A macrotask boundary lets every promise chain started by a timer callback settle.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A controllable clock with its own timers. Time only moves when a test calls `advance`, `set` or
 * `runAll`; due timers then run in deadline order with pending promises settled between them.
 * Time never moves backwards.
 */
export class FakeClock implements Clock {
  private current: number;
  private readonly timers = new Map<number, ScheduledTimer>();
  private nextId = 1;
  private sequence = 0;

  constructor(start: number | Date = defaultFakeClockStart) {
    this.current = typeof start === "number" ? start : start.getTime();
    if (!Number.isFinite(this.current)) throw new RangeError("FakeClock needs a finite start time");
  }

  now(): number {
    return this.current;
  }

  date(): Date {
    return new Date(this.current);
  }

  /** Bound `now`, for APIs that take a `() => number`. */
  readonly nowFn = (): number => this.current;

  setTimeout(callback: () => void, delayMs: number): FakeTimerHandle {
    return this.schedule(callback, delayMs, null);
  }

  setInterval(callback: () => void, intervalMs: number): FakeTimerHandle {
    if (!(intervalMs > 0)) throw new RangeError("An interval must be positive");
    return this.schedule(callback, intervalMs, intervalMs);
  }

  clearTimeout(handle: FakeTimerHandle | undefined): void {
    if (handle) this.timers.delete(handle.id);
  }

  clearInterval(handle: FakeTimerHandle | undefined): void {
    this.clearTimeout(handle);
  }

  /** Resolves when the clock has been advanced past `delayMs` from now. */
  sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(resolve, delayMs);
    });
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  /** Moves time forward by `ms`, running every timer that falls due on the way. */
  async advance(ms: number): Promise<void> {
    if (!(ms >= 0) || !Number.isFinite(ms))
      throw new RangeError("advance needs a non-negative duration");
    await this.runUntil(this.current + ms);
  }

  /** Moves time forward to `to`, running due timers. Throws if `to` is in the past. */
  async set(to: number | Date): Promise<void> {
    const target = typeof to === "number" ? to : to.getTime();
    if (target < this.current) throw new RangeError("FakeClock never moves backwards");
    await this.runUntil(target);
  }

  /** Runs timers until none are left, advancing time to each deadline. Intervals are refused. */
  async runAll(maxTimers = 10_000): Promise<void> {
    let ran = 0;
    for (;;) {
      const next = this.nextDue();
      if (!next) return;
      if (next.intervalMs !== null) {
        throw new Error("runAll cannot finish while an interval is scheduled; use advance instead");
      }
      ran += 1;
      if (ran > maxTimers) throw new Error(`runAll stopped after ${maxTimers} timers`);
      await this.runUntil(next.dueAt);
    }
  }

  private schedule(
    callback: () => void,
    delayMs: number,
    intervalMs: number | null,
  ): FakeTimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.sequence += 1;
    this.timers.set(id, {
      id,
      dueAt: this.current + Math.max(0, delayMs),
      intervalMs,
      callback,
      order: this.sequence,
    });
    return { id };
  }

  private nextDue(): ScheduledTimer | undefined {
    let best: ScheduledTimer | undefined;
    for (const timer of this.timers.values()) {
      if (
        !best ||
        timer.dueAt < best.dueAt ||
        (timer.dueAt === best.dueAt && timer.order < best.order)
      ) {
        best = timer;
      }
    }
    return best;
  }

  private async runUntil(target: number): Promise<void> {
    await drainMicrotasks();
    for (;;) {
      const next = this.nextDue();
      if (!next || next.dueAt > target) break;
      this.current = next.dueAt;
      if (next.intervalMs === null) {
        this.timers.delete(next.id);
      } else {
        next.dueAt += next.intervalMs;
      }
      next.callback();
      await drainMicrotasks();
    }
    this.current = target;
    await drainMicrotasks();
  }
}
