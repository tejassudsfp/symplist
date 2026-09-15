import { type Clock, DbError } from "@symplist/db";

interface Timer {
  readonly at: number;
  readonly resolve: () => void;
}

/** A clock that only moves when a test advances it; `sleep` resolves in time order. */
export class ManualClock implements Clock {
  private current: number;
  private timers: Timer[] = [];

  constructor(startMs = 1_789_500_000_000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DbError("db.aborted", "D1 request aborted by the caller"));
        return;
      }
      const timer: Timer = {
        at: this.current + Math.max(0, ms),
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.timers = this.timers.filter((entry) => entry !== timer);
        reject(new DbError("db.aborted", "D1 request aborted by the caller"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.timers.push(timer);
    });
  }

  /** Timers not yet due. */
  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Moves time forward, resolving due sleeps in order and letting their continuations run. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      await flushMicrotasks();
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.current = Math.max(this.current, due.at);
      due.resolve();
    }
    this.current = target;
    await flushMicrotasks();
  }
}

/** Lets pending promise continuations run. */
export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
