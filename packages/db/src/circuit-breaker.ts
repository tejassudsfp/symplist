import { DbRateLimitedError } from "./errors.ts";
import { type Clock, systemClock } from "./rate-limit.ts";

/** Circuit duration when a 429 carries no usable `Retry-After` (the Cloudflare block lasts 5 minutes). */
export const DEFAULT_RETRY_AFTER_MS = 300_000;
const MAX_RETRY_AFTER_MS = 3_600_000;

export interface RateLimitPolicy {
  readonly name: string;
  /** Requests left in the current window (`r`, or `remaining`). */
  readonly remaining?: number;
  /** Seconds until the window resets (`t`, or `reset`). */
  readonly resetSeconds?: number;
  /** Window quota (`q`, or `limit`), usually from `Ratelimit-Policy`. */
  readonly quota?: number;
  /** Window length in seconds (`w`). */
  readonly windowSeconds?: number;
}

/**
 * Parses `Retry-After` (delta seconds or an HTTP date) into milliseconds, defaulting to 300 seconds
 * when absent or malformed.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number {
  if (value === null || value === undefined || value.trim() === "") return DEFAULT_RETRY_AFTER_MS;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return clampRetry(Number(trimmed) * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return DEFAULT_RETRY_AFTER_MS;
  return clampRetry(date - nowMs);
}

function clampRetry(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, Math.ceil(ms)));
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value.trim().replace(/^"|"$/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/**
 * Parses rate-limit headers in both the IETF structured form Cloudflare documents
 * (`Ratelimit: "default";r=50;t=30`, `Ratelimit-Policy: "default";q=100;w=60`) and the older
 * draft form (`RateLimit: limit=100, remaining=50, reset=30`, or separate `RateLimit-Remaining` and
 * `RateLimit-Reset` headers). Unknown parameters are ignored.
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitPolicy[] {
  const policies = new Map<
    string,
    { -readonly [K in keyof RateLimitPolicy]: RateLimitPolicy[K] }
  >();
  const policy = (name: string) => {
    let entry = policies.get(name);
    if (!entry) {
      entry = { name };
      policies.set(name, entry);
    }
    return entry;
  };

  const parseStructured = (
    header: string,
    apply: (name: string, key: string, value: string) => void,
  ) => {
    for (const item of header.split(",")) {
      const parts = item.split(";").map((part) => part.trim());
      const head = parts.shift();
      if (head === undefined) continue;
      if (head.includes("=")) {
        // Draft form: `limit=100, remaining=50, reset=30` (one policy spread across items).
        const [key, value] = head.split("=", 2);
        if (key && value !== undefined) apply("default", key.trim().toLowerCase(), value);
        continue;
      }
      const name = head.replace(/^"|"$/g, "") || "default";
      for (const parameter of parts) {
        const [key, value] = parameter.split("=", 2);
        if (key && value !== undefined) apply(name, key.trim().toLowerCase(), value);
      }
      if (parts.length === 0) policy(name);
    }
  };

  const ratelimit = headers.get("ratelimit");
  if (ratelimit) {
    parseStructured(ratelimit, (name, key, value) => {
      const entry = policy(name);
      if (key === "r" || key === "remaining") entry.remaining = finiteNumber(value);
      else if (key === "t" || key === "reset") entry.resetSeconds = finiteNumber(value);
      else if (key === "limit") entry.quota = finiteNumber(value);
    });
  }
  const policyHeader = headers.get("ratelimit-policy");
  if (policyHeader) {
    parseStructured(policyHeader, (name, key, value) => {
      const entry = policy(name);
      if (key === "q") entry.quota = finiteNumber(value);
      else if (key === "w") entry.windowSeconds = finiteNumber(value);
    });
  }
  const remaining = finiteNumber(headers.get("ratelimit-remaining") ?? undefined);
  const reset = finiteNumber(headers.get("ratelimit-reset") ?? undefined);
  const limit = finiteNumber(headers.get("ratelimit-limit") ?? undefined);
  if (remaining !== undefined || reset !== undefined || limit !== undefined) {
    const entry = policy("default");
    entry.remaining ??= remaining;
    entry.resetSeconds ??= reset;
    entry.quota ??= limit;
  }
  return [...policies.values()];
}

export type CircuitOpenReason = "http_429" | "ratelimit_exhausted";

export interface CircuitBreakerOptions {
  readonly clock?: Clock;
  /**
   * When a `Ratelimit` policy reports this many requests or fewer remaining, the circuit opens until
   * the window resets, because a breach blocks every Cloudflare API call for 5 minutes (§3.1).
   */
  readonly reserveRequests?: number;
}

export interface CircuitState {
  readonly open: boolean;
  /** Milliseconds until the circuit closes (0 when closed). */
  readonly retryAfterMs: number;
  readonly reason: CircuitOpenReason | undefined;
  /** Times the circuit has opened since the process started. */
  readonly openedCount: number;
  /** Lowest `remaining` seen in the last rate-limit headers, when present. */
  readonly lastRemaining: number | undefined;
}

/** Process-wide circuit for D1 rate limiting (§3.1). */
export class D1CircuitBreaker {
  private readonly clock: Clock;
  private readonly reserveRequests: number;
  private openUntil = 0;
  private reason: CircuitOpenReason | undefined;
  private openedCount = 0;
  private lastRemaining: number | undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.reserveRequests = options.reserveRequests ?? 10;
  }

  state(): CircuitState {
    const now = this.clock.now();
    const open = now < this.openUntil;
    return {
      open,
      retryAfterMs: open ? this.openUntil - now : 0,
      reason: open ? this.reason : undefined,
      openedCount: this.openedCount,
      lastRemaining: this.lastRemaining,
    };
  }

  /** Throws `rate.limited` while the circuit is open. */
  assertClosed(): void {
    const state = this.state();
    if (state.open) throw new DbRateLimitedError("circuit_open", state.retryAfterMs);
  }

  /** Opens (or extends) the circuit for `ms`. */
  open(ms: number, reason: CircuitOpenReason): void {
    const until = this.clock.now() + ms;
    if (until > this.openUntil) {
      if (this.clock.now() >= this.openUntil) this.openedCount += 1;
      this.openUntil = until;
      this.reason = reason;
    }
  }

  /** Records a 429 response; returns the circuit duration applied. */
  recordTooManyRequests(headers: Headers): number {
    const ms = parseRetryAfter(headers.get("retry-after"), this.clock.now());
    this.open(ms, "http_429");
    return ms;
  }

  /** Honors `Ratelimit` and `Ratelimit-Policy` headers on any response. */
  observeHeaders(headers: Headers): readonly RateLimitPolicy[] {
    const policies = parseRateLimitHeaders(headers);
    let lowest: number | undefined;
    for (const policy of policies) {
      if (policy.remaining === undefined) continue;
      lowest = lowest === undefined ? policy.remaining : Math.min(lowest, policy.remaining);
      if (policy.remaining <= this.reserveRequests) {
        const resetMs =
          policy.resetSeconds !== undefined
            ? clampRetry(policy.resetSeconds * 1000)
            : DEFAULT_RETRY_AFTER_MS;
        this.open(resetMs, "ratelimit_exhausted");
      }
    }
    if (lowest !== undefined) this.lastRemaining = lowest;
    return policies;
  }

  /** Closes the circuit; for tests and operator tooling. */
  reset(): void {
    this.openUntil = 0;
    this.reason = undefined;
  }
}

/** The circuit shared by every D1 client in this process. */
export const processCircuitBreaker = new D1CircuitBreaker();
