import type { Clock } from "../../common/clock.ts";

export interface FixedWindowResult {
  /** Hits counted in the current window, including this one. */
  readonly hits: number;
  /** Whether the key is over its limit (or still blocked from an earlier breach). */
  readonly blocked: boolean;
  /** Milliseconds until the window resets. */
  readonly windowRemainingMs: number;
  /** Milliseconds until the block lifts; 0 when not blocked. */
  readonly blockRemainingMs: number;
}

interface Window {
  hits: number;
  windowEnd: number;
  blockedUntil: number;
}

/**
 * Bounded in-memory fixed-window counters with a block period after a breach, keyed by opaque
 * strings (bucket name and IP network). State resets on restart and deploy, so these only back the
 * per-IP buckets (§5.8); counters that protect a secret are durable in D1.
 */
export class FixedWindowCounters {
  private readonly clock: Clock;
  private readonly maxKeys: number;
  private readonly windows = new Map<string, Window>();

  constructor(options: { readonly clock: Clock; readonly maxKeys?: number }) {
    this.clock = options.clock;
    this.maxKeys = options.maxKeys ?? 100_000;
  }

  /** Counts one hit. The hit that exceeds `limit` starts a block of `blockMs`. */
  hit(key: string, limit: number, windowMs: number, blockMs: number): FixedWindowResult {
    const now = this.clock.now();
    let window = this.windows.get(key);
    if (window && window.blockedUntil > now) {
      return this.result(window, now);
    }
    if (!window || window.windowEnd <= now) {
      if (!window) this.makeRoom(now);
      window = { hits: 0, windowEnd: now + windowMs, blockedUntil: 0 };
      this.windows.set(key, window);
    }
    window.hits += 1;
    if (window.hits > limit) window.blockedUntil = now + blockMs;
    return this.result(window, now);
  }

  /** The state of a key without counting a hit. */
  peek(key: string): FixedWindowResult | null {
    const now = this.clock.now();
    const window = this.windows.get(key);
    if (!window || (window.windowEnd <= now && window.blockedUntil <= now)) return null;
    return this.result(window, now);
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  get size(): number {
    return this.windows.size;
  }

  private result(window: Window, now: number): FixedWindowResult {
    const blockRemainingMs = Math.max(0, window.blockedUntil - now);
    return {
      hits: window.hits,
      blocked: blockRemainingMs > 0,
      windowRemainingMs: Math.max(0, window.windowEnd - now),
      blockRemainingMs,
    };
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [key, window] of this.windows) {
      if (window.windowEnd <= now && window.blockedUntil <= now) this.windows.delete(key);
    }
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }
}
