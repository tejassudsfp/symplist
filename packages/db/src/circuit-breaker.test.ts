import { describe, expect, it } from "vitest";
import { ManualClock } from "../../testing/src/contracts/db/manual-clock.ts";
import {
  D1CircuitBreaker,
  DEFAULT_RETRY_AFTER_MS,
  parseRateLimitHeaders,
  parseRetryAfter,
} from "./circuit-breaker.ts";
import { DbRateLimitedError } from "./errors.ts";

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");

  it("reads delta seconds and HTTP dates", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Tue, 15 Sep 2026 12:01:30 GMT", now)).toBe(90_000);
  });

  it("defaults to 300 seconds when absent or malformed, and clamps extremes", () => {
    expect(parseRetryAfter(null, now)).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(parseRetryAfter("", now)).toBe(300_000);
    expect(parseRetryAfter("soon", now)).toBe(300_000);
    expect(parseRetryAfter("0", now)).toBe(1_000);
    expect(parseRetryAfter("Tue, 15 Sep 2026 11:00:00 GMT", now)).toBe(1_000);
    expect(parseRetryAfter("999999", now)).toBe(3_600_000);
  });
});

describe("parseRateLimitHeaders", () => {
  it("parses the structured form Cloudflare documents", () => {
    const headers = new Headers({
      Ratelimit: '"default";r=50;t=30',
      "Ratelimit-Policy": '"default";q=1200;w=300, "burst";q=100;w=60',
    });
    expect(parseRateLimitHeaders(headers)).toEqual([
      { name: "default", remaining: 50, resetSeconds: 30, quota: 1200, windowSeconds: 300 },
      { name: "burst", quota: 100, windowSeconds: 60 },
    ]);
    expect(parseRateLimitHeaders(new Headers({ RateLimit: "default;r=5;t=10" }))).toEqual([
      { name: "default", remaining: 5, resetSeconds: 10 },
    ]);
  });

  it("parses the older draft forms", () => {
    expect(
      parseRateLimitHeaders(new Headers({ RateLimit: "limit=100, remaining=7, reset=12" })),
    ).toEqual([{ name: "default", quota: 100, remaining: 7, resetSeconds: 12 }]);
    expect(
      parseRateLimitHeaders(
        new Headers({
          "RateLimit-Limit": "100",
          "RateLimit-Remaining": "3",
          "RateLimit-Reset": "9",
        }),
      ),
    ).toEqual([{ name: "default", remaining: 3, resetSeconds: 9, quota: 100 }]);
  });

  it("ignores absent and malformed values", () => {
    expect(parseRateLimitHeaders(new Headers())).toEqual([]);
    expect(parseRateLimitHeaders(new Headers({ Ratelimit: '"default";r=abc;t=-1' }))).toEqual([
      { name: "default", remaining: undefined, resetSeconds: undefined },
    ]);
  });
});

describe("D1CircuitBreaker", () => {
  it("opens for Retry-After on a 429 and fails fast with rate.limited until it closes", async () => {
    const clock = new ManualClock();
    const circuit = new D1CircuitBreaker({ clock });
    expect(() => circuit.assertClosed()).not.toThrow();
    expect(circuit.recordTooManyRequests(new Headers({ "Retry-After": "30" }))).toBe(30_000);
    let error: unknown;
    try {
      circuit.assertClosed();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DbRateLimitedError);
    expect(error).toMatchObject({
      code: "rate.limited",
      reason: "circuit_open",
      retryAfterMs: 30_000,
    });
    expect((error as DbRateLimitedError).retryAfterSeconds).toBe(30);
    expect(circuit.state()).toMatchObject({ open: true, reason: "http_429", openedCount: 1 });
    await clock.advance(29_999);
    expect(circuit.state().open).toBe(true);
    await clock.advance(1);
    expect(circuit.state()).toMatchObject({ open: false, retryAfterMs: 0 });
    expect(() => circuit.assertClosed()).not.toThrow();
  });

  it("defaults to a 300-second circuit and never shortens an open circuit", async () => {
    const clock = new ManualClock();
    const circuit = new D1CircuitBreaker({ clock });
    circuit.recordTooManyRequests(new Headers());
    circuit.recordTooManyRequests(new Headers({ "Retry-After": "5" }));
    expect(circuit.state()).toMatchObject({ retryAfterMs: 300_000, openedCount: 1 });
    await clock.advance(300_000);
    circuit.recordTooManyRequests(new Headers({ "Retry-After": "5" }));
    expect(circuit.state()).toMatchObject({ open: true, retryAfterMs: 5_000, openedCount: 2 });
  });

  it("honors Ratelimit headers: opens until reset when the remaining budget is exhausted", async () => {
    const clock = new ManualClock();
    const circuit = new D1CircuitBreaker({ clock, reserveRequests: 10 });
    circuit.observeHeaders(new Headers({ Ratelimit: '"default";r=500;t=200' }));
    expect(circuit.state()).toMatchObject({ open: false, lastRemaining: 500 });
    circuit.observeHeaders(new Headers({ Ratelimit: '"default";r=10;t=45' }));
    expect(circuit.state()).toMatchObject({
      open: true,
      retryAfterMs: 45_000,
      reason: "ratelimit_exhausted",
    });
    circuit.reset();
    circuit.observeHeaders(new Headers({ Ratelimit: '"default";r=0' }));
    expect(circuit.state()).toMatchObject({ open: true, retryAfterMs: 300_000 });
  });
});
