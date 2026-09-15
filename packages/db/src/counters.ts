import type { D1CircuitBreaker } from "./circuit-breaker.ts";
import type { Clock } from "./rate-limit.ts";
import { systemClock } from "./rate-limit.ts";

export type D1Runtime = "api" | "worker" | "migrations" | "local";

/** How a client call ended. `shed`, `circuit_open`, `queue_timeout` and `invalid` never reached D1. */
export const d1Outcomes = [
  "ok",
  "statement_failed",
  "http_429",
  "shed",
  "circuit_open",
  "queue_timeout",
  "unknown_outcome",
  "unavailable",
  "unauthorized",
  "rejected",
  "invalid",
  "aborted",
] as const;

export type D1Outcome = (typeof d1Outcomes)[number];

/**
 * One minute of D1 client counters (§3.1). Only numbers and fixed ids: never SQL, parameters,
 * row data, tokens or provider messages.
 */
export interface D1CounterSnapshot {
  readonly metric: "d1.requests";
  readonly runtime: D1Runtime;
  readonly lane: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /** HTTP requests sent to D1 (each attempt, including read retries). */
  readonly requestsSent: number;
  /** Client calls by outcome. */
  readonly outcomes: Readonly<Record<D1Outcome, number>>;
  readonly http429: number;
  readonly readRetries: number;
  /** 1 while the process-wide circuit is open at snapshot time. */
  readonly circuitOpen: 0 | 1;
  readonly circuitOpenedTotal: number;
  readonly bucketWaits: number;
  readonly bucketWaitMsTotal: number;
  readonly bucketWaitMsMax: number;
  /** Lowest `Ratelimit` remaining value seen this window, or -1 when no header was seen. */
  readonly ratelimitRemainingMin: number;
}

function emptyOutcomes(): Record<D1Outcome, number> {
  return Object.fromEntries(d1Outcomes.map((outcome) => [outcome, 0])) as Record<D1Outcome, number>;
}

export interface D1CountersOptions {
  readonly runtime: D1Runtime;
  readonly lane: string;
  readonly clock?: Clock;
  /** Supplies circuit state for snapshots. */
  readonly circuit?: D1CircuitBreaker;
}

/** Per-minute structured counters for one D1 client. */
export class D1Counters {
  readonly runtime: D1Runtime;
  readonly lane: string;
  private readonly clock: Clock;
  private readonly circuit: D1CircuitBreaker | undefined;
  private windowStartMs: number;
  private requestsSent = 0;
  private outcomes = emptyOutcomes();
  private http429 = 0;
  private readRetries = 0;
  private bucketWaits = 0;
  private bucketWaitMsTotal = 0;
  private bucketWaitMsMax = 0;
  private ratelimitRemainingMin = -1;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: D1CountersOptions) {
    this.runtime = options.runtime;
    this.lane = options.lane;
    this.clock = options.clock ?? systemClock;
    this.circuit = options.circuit;
    this.windowStartMs = this.clock.now();
  }

  recordSent(): void {
    this.requestsSent += 1;
  }

  recordOutcome(outcome: D1Outcome): void {
    this.outcomes[outcome] += 1;
    if (outcome === "http_429") this.http429 += 1;
  }

  recordRetry(): void {
    this.readRetries += 1;
  }

  recordBucketWait(ms: number): void {
    if (ms <= 0) return;
    this.bucketWaits += 1;
    this.bucketWaitMsTotal += ms;
    this.bucketWaitMsMax = Math.max(this.bucketWaitMsMax, ms);
  }

  recordRemaining(remaining: number): void {
    this.ratelimitRemainingMin =
      this.ratelimitRemainingMin === -1
        ? remaining
        : Math.min(this.ratelimitRemainingMin, remaining);
  }

  /** Returns the current window and starts a new one. */
  snapshot(): D1CounterSnapshot {
    const now = this.clock.now();
    const circuit = this.circuit?.state();
    const snapshot: D1CounterSnapshot = {
      metric: "d1.requests",
      runtime: this.runtime,
      lane: this.lane,
      windowStartMs: this.windowStartMs,
      windowEndMs: now,
      requestsSent: this.requestsSent,
      outcomes: { ...this.outcomes },
      http429: this.http429,
      readRetries: this.readRetries,
      circuitOpen: circuit?.open ? 1 : 0,
      circuitOpenedTotal: circuit?.openedCount ?? 0,
      bucketWaits: this.bucketWaits,
      bucketWaitMsTotal: this.bucketWaitMsTotal,
      bucketWaitMsMax: this.bucketWaitMsMax,
      ratelimitRemainingMin: this.ratelimitRemainingMin,
    };
    this.windowStartMs = now;
    this.requestsSent = 0;
    this.outcomes = emptyOutcomes();
    this.http429 = 0;
    this.readRetries = 0;
    this.bucketWaits = 0;
    this.bucketWaitMsTotal = 0;
    this.bucketWaitMsMax = 0;
    this.ratelimitRemainingMin = -1;
    return snapshot;
  }

  /** Emits a snapshot every `intervalMs` (default one minute) without keeping the process alive. */
  start(emit: (snapshot: D1CounterSnapshot) => void, intervalMs = 60_000): () => void {
    this.stop();
    this.timer = setInterval(() => emit(this.snapshot()), intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
