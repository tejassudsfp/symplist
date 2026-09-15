import type { ResolvedSession } from "@symplist/core/access";
import { FakeClock } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import { ACCESS_CACHE_TTL_MS, SessionCache } from "./session-cache.ts";
import { NEGATIVE_CACHE_TTL_MS, NegativeCache, TtlCache } from "./ttl-cache.ts";

function resolved(
  userId: string,
  sessionId: string,
  generation: number,
  expiresAt: number,
): ResolvedSession {
  return {
    session: { id: sessionId, userId, createdAt: 0, lastSeenAt: 0, expiresAt },
    access: {
      emailVerifiedAt: 1,
      betaState: "unlocked",
      suspendedAt: null,
      onboardingStep: "done",
      role: "member",
      accessGeneration: generation,
      accessEpoch: 0,
      deletionState: "none",
    },
  };
}

describe("TTL caches (§3.3)", () => {
  it("never serves an entry at or after its TTL and evicts the oldest beyond the limit", async () => {
    const clock = new FakeClock();
    const cache = new TtlCache<string, number>({ clock, ttlMs: 1000, maxEntries: 2 });
    cache.set("a", 1);
    await clock.advance(999);
    expect(cache.get("a")).toBe(1);
    await clock.advance(1);
    expect(cache.get("a")).toBeUndefined();
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);
    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.deleteWhere((value) => value === 4)).toBe(1);
    expect(() => new TtlCache({ clock, ttlMs: 0, maxEntries: 1 })).toThrow(RangeError);
  });

  it("holds negative lookups for 60 seconds", async () => {
    const clock = new FakeClock();
    const cache = new NegativeCache({ clock });
    cache.rememberMissing("digest");
    await clock.advance(NEGATIVE_CACHE_TTL_MS - 1);
    expect(cache.isKnownMissing("digest")).toBe(true);
    await clock.advance(1);
    expect(cache.isKnownMissing("digest")).toBe(false);
    cache.rememberMissing("other");
    cache.forget("other");
    expect(cache.isKnownMissing("other")).toBe(false);
  });

  it("keeps session entries 10 seconds, never past session expiry, and evicts by user, session or generation", async () => {
    const clock = new FakeClock();
    const cache = new SessionCache({ clock });
    const now = clock.now();
    cache.set("d1", resolved("u1", "s1", 1, now + 60_000));
    cache.set("d2", resolved("u1", "s2", 1, now + 5_000));
    cache.set("d3", resolved("u2", "s3", 4, now + 60_000));
    await clock.advance(5_000);
    expect(cache.get("d2")).toBeUndefined();
    expect(cache.get("d1")?.access.accessGeneration).toBe(1);
    await clock.advance(ACCESS_CACHE_TTL_MS - 5_000);
    expect(cache.get("d1")).toBeUndefined();

    cache.set("d1", resolved("u1", "s1", 1, clock.now() + 60_000));
    expect(cache.evictStaleGeneration("u1", 2)).toBe(1);
    cache.set("d1", resolved("u1", "s1", 2, clock.now() + 60_000));
    expect(cache.evictSession("s1")).toBe(1);
    cache.set("d3", resolved("u2", "s3", 4, clock.now() + 60_000));
    expect(cache.evictUser("u2")).toBe(1);

    // After a local restriction to generation 3, a read of generation 2 still in flight is not cached.
    cache.set("d5", resolved("u5", "s5", 2, clock.now() + 60_000));
    expect(cache.evictUser("u5", 3)).toBe(1);
    expect(cache.set("d5", resolved("u5", "s5", 2, clock.now() + 60_000))).toBe(false);
    expect(cache.get("d5")).toBeUndefined();
    expect(cache.set("d5", resolved("u5", "s5", 3, clock.now() + 60_000))).toBe(true);
    expect(cache.get("d5")?.access.accessGeneration).toBe(3);
    cache.evictUser("u5", 1);
    expect(cache.set("d6", resolved("u5", "s6", 2, clock.now() + 60_000))).toBe(false);

    // A revoked session is not cached again from a read that was already in flight.
    cache.set("d7", resolved("u7", "s7", 0, clock.now() + 60_000));
    expect(cache.evictSession("s7", { revoked: true })).toBe(1);
    expect(cache.set("d7", resolved("u7", "s7", 0, clock.now() + 60_000))).toBe(false);
    expect(cache.set("d8", resolved("u7", "s8", 0, clock.now() + 60_000))).toBe(true);

    cache.rememberMissing("d4");
    expect(cache.isKnownMissing("d4")).toBe(true);
    cache.set("d4", resolved("u3", "s4", 0, clock.now() + 60_000));
    expect(cache.isKnownMissing("d4")).toBe(false);
  });
});
