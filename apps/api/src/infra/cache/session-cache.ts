import type { ResolvedSession } from "@symplist/core/access";
import type { Clock } from "../../common/clock.ts";
import { NegativeCache, TtlCache } from "./ttl-cache.ts";

/** Session and access-state cache entries have a hard 10-second TTL (§3.3). */
export const ACCESS_CACHE_TTL_MS = 10_000;

/**
 * How long a local restriction's generation floor is kept: longer than any D1 request can stay in
 * flight (the 35-second client abort, §3.2), so a read that started before the commit never lands.
 */
export const GENERATION_FLOOR_TTL_MS = 60_000;

/**
 * The 10-second session and access-state cache (§3.3), keyed by the session token's digest under the
 * current secret version, so raw tokens are never held as keys. Every entry carries the user's
 * `access_generation`; restrictions, restores and revocations in this process evict entries at once,
 * and the TTL bounds how long another instance (a deploy overlap) can serve a stale entry.
 */
export class SessionCache {
  private readonly entries: TtlCache<string, ResolvedSession>;
  private readonly missing: NegativeCache;
  /**
   * The lowest `access_generation` this process may cache per user after a local restriction, so a
   * session read that started before the restriction committed cannot repopulate the cache with the
   * old access once the eviction ran.
   */
  private readonly floors: TtlCache<string, number>;
  /** Sessions this process revoked recently; a read still in flight for one of them is not cached. */
  private readonly revoked: TtlCache<string, true>;
  private readonly clock: Clock;

  constructor(options: { readonly clock: Clock; readonly maxEntries?: number }) {
    this.clock = options.clock;
    this.entries = new TtlCache({
      clock: options.clock,
      ttlMs: ACCESS_CACHE_TTL_MS,
      maxEntries: options.maxEntries ?? 10_000,
    });
    this.floors = new TtlCache({
      clock: options.clock,
      ttlMs: GENERATION_FLOOR_TTL_MS,
      maxEntries: options.maxEntries ?? 10_000,
    });
    this.revoked = new TtlCache({
      clock: options.clock,
      ttlMs: GENERATION_FLOOR_TTL_MS,
      maxEntries: options.maxEntries ?? 10_000,
    });
    this.missing = new NegativeCache({
      clock: options.clock,
      maxEntries: options.maxEntries ?? 10_000,
    });
  }

  /** A cached live session for a token digest; entries past the session's expiry are dropped. */
  get(digest: string): ResolvedSession | undefined {
    const entry = this.entries.get(digest);
    if (entry && entry.session.expiresAt <= this.clock.now()) {
      this.entries.delete(digest);
      return undefined;
    }
    return entry;
  }

  /**
   * Caches a resolved session. Returns false, caching nothing, when the read carries an older
   * generation than a restriction this process already committed for the user, or names a session
   * this process revoked since.
   */
  set(digest: string, resolved: ResolvedSession): boolean {
    this.missing.forget(digest);
    const floor = this.floors.get(resolved.session.userId);
    if (
      (floor !== undefined && resolved.access.accessGeneration < floor) ||
      this.revoked.has(resolved.session.id)
    ) {
      this.entries.delete(digest);
      return false;
    }
    this.entries.set(digest, resolved);
    return true;
  }

  /** Whether the digest recently resolved to no live session (60-second negative cache). */
  isKnownMissing(digest: string): boolean {
    return this.missing.isKnownMissing(digest);
  }

  rememberMissing(digest: string): void {
    this.entries.delete(digest);
    this.missing.rememberMissing(digest);
  }

  /**
   * Evicts every entry of a user: after a restriction, restore or access change. With the
   * generation the change committed, reads of an older generation are no longer cached either.
   */
  evictUser(userId: string, accessGeneration?: number): number {
    if (accessGeneration !== undefined) {
      const floor = this.floors.get(userId);
      this.floors.set(userId, Math.max(floor ?? 0, accessGeneration));
    }
    return this.entries.deleteWhere((entry) => entry.session.userId === userId);
  }

  /**
   * Evicts one session: after logout or revocation. With `revoked`, a read of that session still in
   * flight is not cached afterwards either.
   */
  evictSession(sessionId: string, options: { readonly revoked?: boolean } = {}): number {
    if (options.revoked) this.revoked.set(sessionId, true);
    return this.entries.deleteWhere((entry) => entry.session.id === sessionId);
  }

  /** Evicts entries of a user whose generation is older than `generation`. */
  evictStaleGeneration(userId: string, generation: number): number {
    return this.entries.deleteWhere(
      (entry) => entry.session.userId === userId && entry.access.accessGeneration < generation,
    );
  }

  clear(): void {
    this.entries.clear();
    this.floors.clear();
    this.revoked.clear();
  }
}
