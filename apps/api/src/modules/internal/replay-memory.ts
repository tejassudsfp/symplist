import type { RuntimeTimers } from "../../infra/scheduler/runtime.ts";

export type ReserveOutcome = "reserved" | "replayed" | "full";

/**
 * Remembers verified internal event ids for 10 minutes (§6.2), which covers the whole ±300-second
 * signature window. Only requests with a valid signature reach it, so only a holder of the internal
 * secret can fill it; when full it refuses new ids (fail closed) rather than forgetting live ones.
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

  reserve(eventId: string): ReserveOutcome {
    const now = this.timers.now();
    this.purge(now);
    const expiresAt = this.entries.get(eventId);
    if (expiresAt !== undefined && expiresAt > now) return "replayed";
    if (this.entries.size >= this.capacity) return "full";
    this.entries.set(eventId, now + this.ttlMs);
    return "reserved";
  }

  /** Forgets an id whose request failed before taking effect, so the sender may retry it. */
  release(eventId: string): void {
    this.entries.delete(eventId);
  }

  private purge(now: number): void {
    // Entries are inserted with a constant TTL, so map order is expiry order.
    for (const [eventId, expiresAt] of this.entries) {
      if (expiresAt > now) break;
      this.entries.delete(eventId);
    }
  }
}
