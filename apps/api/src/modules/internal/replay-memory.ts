import type { RuntimeTimers } from "../../infra/scheduler/runtime.ts";

export type ReserveOutcome = "reserved" | "replayed" | "full";

/**
 * Remembers verified internal event ids for 10 minutes (§6.2). An id is also kept until its signed
 * timestamp has left the ±300-second window, so a request first accepted early in its window (a worker
 * clock ahead of the api's) can never be replayed in the last second of it. Only requests with a valid
 * signature reach it, so only a holder of the internal secret can fill it; when full it refuses new ids
 * (fail closed) rather than forgetting live ones.
 */
export class EventIdMemory {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly capacity: number;

  constructor(
    private readonly timers: RuntimeTimers,
    options: { readonly ttlMs?: number; readonly capacity?: number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.capacity = options.capacity ?? 200_000;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Reserves a verified event id. `freshUntilMs` is the first instant at which the request's signature
   * is stale (UTC epoch milliseconds); the id is remembered at least until then.
   */
  reserve(eventId: string, freshUntilMs = 0): ReserveOutcome {
    const now = this.timers.now();
    this.purge(now);
    const expiresAt = this.entries.get(eventId);
    if (expiresAt !== undefined && expiresAt > now) return "replayed";
    if (this.entries.size >= this.capacity) return "full";
    // Re-inserting moves the id to the end, keeping map order close to expiry order.
    this.entries.delete(eventId);
    this.entries.set(eventId, Math.max(now + this.ttlMs, freshUntilMs));
    return "reserved";
  }

  /** Forgets an id whose request failed before taking effect, so the sender may retry it. */
  release(eventId: string): void {
    this.entries.delete(eventId);
  }

  private purge(now: number): void {
    // Entries are inserted with a TTL of 10 minutes, extended by at most a second to the end of their
    // signature window, so map order is expiry order within a second. Stopping at the first live entry
    // can only keep an expired id slightly longer, never forget a live one.
    for (const [eventId, expiresAt] of this.entries) {
      if (expiresAt > now) break;
      this.entries.delete(eventId);
    }
  }
}
