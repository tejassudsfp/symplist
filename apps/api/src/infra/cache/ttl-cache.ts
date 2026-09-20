import type { Clock } from "../../common/clock.ts";

export interface TtlCacheOptions {
  readonly clock: Clock;
  readonly ttlMs: number;
  /** Oldest entries are evicted beyond this size, so a flood of keys cannot exhaust memory. */
  readonly maxEntries: number;
}

interface Entry<Value> {
  readonly value: Value;
  readonly expiresAt: number;
}

/**
 * A bounded in-memory cache with a hard time-to-live per entry. Entries are never served after
 * their TTL, even if nothing evicted them yet (§3.3).
 */
export class TtlCache<Key, Value> {
  readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly maxEntries: number;
  private readonly entries = new Map<Key, Entry<Value>>();

  constructor(options: TtlCacheOptions) {
    if (
      !(options.ttlMs > 0) ||
      !Number.isSafeInteger(options.maxEntries) ||
      options.maxEntries < 1
    ) {
      throw new RangeError("A TTL cache needs a positive TTL and entry limit");
    }
    this.clock = options.clock;
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: Key): Value | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: Key): boolean {
    return this.get(key) !== undefined;
  }

  set(key: Key, value: Value): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) this.evict();
    this.entries.set(key, { value, expiresAt: this.clock.now() + this.ttlMs });
  }

  delete(key: Key): boolean {
    return this.entries.delete(key);
  }

  /** Deletes every entry whose value matches. */
  deleteWhere(predicate: (value: Value, key: Key) => boolean): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (predicate(entry.value, key)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    const now = this.clock.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/** Negative caches hold unknown lookups for 60 seconds (§3.3, §5.8). */
export const NEGATIVE_CACHE_TTL_MS = 60_000;

/**
 * A 60-second negative cache (§5.8) for lookups that found nothing: unknown share-token digests,
 * API-key ids, OAuth grant ids and session token digests. Keys are digests or ids, never raw
 * credentials.
 */
export class NegativeCache {
  private readonly cache: TtlCache<string, true>;

  constructor(options: {
    readonly clock: Clock;
    readonly maxEntries?: number;
    readonly ttlMs?: number;
  }) {
    this.cache = new TtlCache({
      clock: options.clock,
      ttlMs: options.ttlMs ?? NEGATIVE_CACHE_TTL_MS,
      maxEntries: options.maxEntries ?? 10_000,
    });
  }

  /** Whether a lookup for `key` recently found nothing. */
  isKnownMissing(key: string): boolean {
    return this.cache.has(key);
  }

  rememberMissing(key: string): void {
    this.cache.set(key, true);
  }

  /** Forgets a key, for example after the resource was created. */
  forget(key: string): void {
    this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }
}
