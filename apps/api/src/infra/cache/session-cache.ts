import type { ResolvedSession } from "@symplist/core/access";
import type { Clock } from "../../common/clock.ts";
import { NegativeCache, TtlCache } from "./ttl-cache.ts";

/** Session and access-state cache entries have a hard 10-second TTL (§3.3). */
export const ACCESS_CACHE_TTL_MS = 10_000;

/**
 * The 10-second session and access-state cache (§3.3), keyed by the session token's digest under the
 * current secret version, so raw tokens are never held as keys. Every entry carries the user's
 * `access_generation`; restrictions, restores and revocations in this process evict entries at once,
 * and the TTL bounds how long another instance (a deploy overlap) can serve a stale entry.
 */
export class SessionCache {
  private readonly entries: TtlCache<string, ResolvedSession>;
  private readonly missing: NegativeCache;
  private readonly clock: Clock;

  constructor(options: { readonly clock: Clock; readonly maxEntries?: number }) {
    this.clock = options.clock;
    this.entries = new TtlCache({
      clock: options.clock,
      ttlMs: ACCESS_CACHE_TTL_MS,
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

  set(digest: string, resolved: ResolvedSession): void {
    this.missing.forget(digest);
    this.entries.set(digest, resolved);
  }

  /** Whether the digest recently resolved to no live session (60-second negative cache). */
  isKnownMissing(digest: string): boolean {
    return this.missing.isKnownMissing(digest);
  }

  rememberMissing(digest: string): void {
    this.entries.delete(digest);
    this.missing.rememberMissing(digest);
  }

  /** Evicts every entry of a user: after a restriction, restore or access change. */
  evictUser(userId: string): number {
    return this.entries.deleteWhere((entry) => entry.session.userId === userId);
  }

  /** Evicts one session: after logout or revocation. */
  evictSession(sessionId: string): number {
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
  }
}
