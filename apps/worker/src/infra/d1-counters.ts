import {
  type Clock,
  type D1CircuitBreaker,
  type D1CounterSnapshot,
  D1Counters,
  type D1Outcome,
  d1Outcomes,
  processCircuitBreaker,
} from "@symplist/db";
import type { WorkerLogger, WorkerLogValue } from "./logger.ts";
import { systemWorkerTimers, type WorkerTimers } from "./timers.ts";

/** The structured event the worker's D1 counters are logged under (§3.1). */
export const D1_COUNTERS_EVENT = "d1.requests";

/** Why a counter window was reported: the per-minute tick, or the end of a task run. */
export type D1CounterReason = "interval" | "task_end";

/** `statement_failed` → `outcomeStatementFailedCount`: a field name the redacting logger keeps. */
function outcomeField(outcome: D1Outcome): string {
  const camel = outcome.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
  return `outcome${camel.charAt(0).toUpperCase()}${camel.slice(1)}Count`;
}

/** The logged field of every D1 outcome, in `d1Outcomes` order. */
export const d1OutcomeFields: Readonly<Record<D1Outcome, string>> = Object.freeze(
  Object.fromEntries(d1Outcomes.map((outcome) => [outcome, outcomeField(outcome)])) as Record<
    D1Outcome,
    string
  >,
);

/** Whether a window saw any D1 activity or an open circuit worth reporting on its own. */
function hasActivity(snapshot: D1CounterSnapshot): boolean {
  return (
    snapshot.requestsSent > 0 ||
    snapshot.bucketWaits > 0 ||
    snapshot.circuitOpen === 1 ||
    d1Outcomes.some((outcome) => snapshot.outcomes[outcome] > 0)
  );
}

/**
 * The log fields of one counter window: runtime and lane as stable codes, then numbers only (requests
 * sent, calls by outcome, 429s, read retries, circuit state, token bucket waits and the lowest
 * `Ratelimit` remaining value). Every name matches the redacting logger's allowlist (§8.3).
 */
export function d1CounterLogFields(
  snapshot: D1CounterSnapshot,
  context: {
    readonly reason: D1CounterReason;
    readonly task?: string;
    readonly runId?: string;
  },
): Record<string, WorkerLogValue> {
  const fields: Record<string, WorkerLogValue> = {
    runtime: snapshot.runtime,
    lane: snapshot.lane,
    reason: context.reason,
    windowStartMs: snapshot.windowStartMs,
    windowMs: Math.max(0, snapshot.windowEndMs - snapshot.windowStartMs),
    requestCount: snapshot.requestsSent,
  };
  for (const outcome of d1Outcomes) fields[d1OutcomeFields[outcome]] = snapshot.outcomes[outcome];
  Object.assign(fields, {
    http429Count: snapshot.http429,
    readRetryCount: snapshot.readRetries,
    isCircuitOpen: snapshot.circuitOpen === 1,
    circuitOpenedCount: snapshot.circuitOpenedTotal,
    bucketWaitCount: snapshot.bucketWaits,
    bucketWaitTotalMs: snapshot.bucketWaitMsTotal,
    bucketWaitMaxMs: snapshot.bucketWaitMsMax,
    ratelimitRemainingCount:
      snapshot.ratelimitRemainingMin < 0 ? null : snapshot.ratelimitRemainingMin,
  });
  if (context.task !== undefined) fields.task = context.task;
  if (context.runId !== undefined) fields.runId = context.runId;
  return fields;
}

export interface WorkerD1CounterReporterOptions {
  readonly counters: D1Counters;
  readonly logger: WorkerLogger;
  readonly timers?: WorkerTimers;
  /** Defaults to one minute (§3.1). */
  readonly intervalMs?: number;
}

/**
 * Reports the worker process's D1 counters (§3.1) through the redacting worker logger: every minute
 * while the process has D1 activity, and at the end of every task run that used D1, so a short task
 * never ends before its counters are seen. Each report closes the counter window and starts the next.
 */
export class WorkerD1CounterReporter {
  private readonly timers: WorkerTimers;
  private readonly intervalMs: number;
  private timer: unknown;

  constructor(private readonly options: WorkerD1CounterReporterOptions) {
    this.timers = options.timers ?? systemWorkerTimers;
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  /** Starts the per-minute reports; idempotent. The timer never keeps the process alive. */
  start(): void {
    if (this.timer !== undefined) return;
    this.schedule();
  }

  stop(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Reports the window so far at the end of a task run, whatever it holds. */
  endTask(context: { readonly task: string; readonly runId?: string }): void {
    this.emit(this.options.counters.snapshot(), { reason: "task_end", ...context });
  }

  private schedule(): void {
    const handle = this.timers.setTimeout(() => {
      this.timer = undefined;
      const snapshot = this.options.counters.snapshot();
      if (hasActivity(snapshot)) this.emit(snapshot, { reason: "interval" });
      this.schedule();
    }, this.intervalMs);
    (handle as { unref?: () => void } | undefined)?.unref?.();
    this.timer = handle;
  }

  private emit(
    snapshot: D1CounterSnapshot,
    context: { readonly reason: D1CounterReason; readonly task?: string; readonly runId?: string },
  ): void {
    this.options.logger.info(D1_COUNTERS_EVENT, d1CounterLogFields(snapshot, context));
  }
}

/**
 * Runs one task body and reports the process's D1 counters when it ends, whether it returned or threw,
 * so every task run that used D1 leaves its counters behind (§3.1). Task files that reach the worker
 * D1 client wrap their work in it; `queues.test.ts` enforces that.
 */
export async function reportingD1Counters<T>(
  reporter: Pick<WorkerD1CounterReporter, "endTask">,
  context: { readonly task: string; readonly runId?: string },
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } finally {
    reporter.endTask(context);
  }
}

/**
 * The worker process's D1 counters: runtime and lane `worker`, with the circuit state read from the
 * process-wide circuit every worker D1 client shares (§3.1).
 */
export function createWorkerD1Counters(
  options: { readonly clock?: Clock; readonly circuit?: D1CircuitBreaker } = {},
): D1Counters {
  return new D1Counters({
    runtime: "worker",
    lane: "worker",
    circuit: options.circuit ?? processCircuitBreaker,
    ...(options.clock ? { clock: options.clock } : {}),
  });
}
