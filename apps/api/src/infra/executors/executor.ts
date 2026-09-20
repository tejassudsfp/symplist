import type { ExecutionJob, ExecutionKindDefinition, ExecutorKind } from "@symplist/core/events";

/** What an executor reports after starting a job. */
export interface StartedExecution {
  readonly executor: ExecutorKind;
  /** The Trigger run id for durable work; null for local work. */
  readonly triggerRunId: string | null;
}

/** A job an executor can cancel or observe. */
export interface ExecutionTarget {
  readonly kind: string;
  readonly subjectId: string;
  readonly triggerRunId: string | null;
}

/** An executor's view of a job, used by the reconciler (§8.1). */
export type ExecutionObservation =
  | { readonly state: "active" }
  | { readonly state: "completed" }
  | { readonly state: "failed"; readonly status: string }
  | { readonly state: "cancelled" }
  /** The executor holds no record of the job (for a local executor: not running in this process). */
  | { readonly state: "unknown" };

/**
 * Runs dispatched jobs in one mode (§8.1). The local executor runs registered handlers in process; the
 * Trigger executor starts Trigger tasks and never runs model or tool code in the api.
 */
export interface Executor {
  readonly kind: ExecutorKind;
  /**
   * Starts a job. `existingTriggerRunId` is the run id already stored for the intent: an executor
   * never starts work again for an intent that already reached Trigger.
   */
  start(
    job: ExecutionJob,
    definition: ExecutionKindDefinition,
    existingTriggerRunId?: string | null,
  ): Promise<StartedExecution>;
  cancel(target: ExecutionTarget): Promise<void>;
  observe(target: ExecutionTarget): Promise<ExecutionObservation>;
}

/** Stable executor failures; messages carry no payloads or provider text (§6.3). */
export type ExecutorErrorCode =
  | "executor.handler_missing"
  | "executor.payload_invalid"
  | "executor.trigger_unavailable"
  | "executor.trigger_rejected"
  | "executor.not_configured"
  | "executor.switch_conflict";

export class ExecutorError extends Error {
  readonly code: ExecutorErrorCode;

  constructor(code: ExecutorErrorCode, message: string) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
  }
}

/**
 * The structural subset of the Trigger.dev SDK the api uses (`TriggerClient` from `@trigger.dev/sdk`
 * 4.6): `tasks.trigger`, `runs.retrieve` and `runs.cancel`. `FakeTriggerClient` from
 * `@symplist/testing` satisfies it.
 */
export interface TriggerRunsClient {
  readonly tasks: {
    trigger(
      taskIdentifier: string,
      payload: unknown,
      options?: { readonly idempotencyKey?: string },
    ): Promise<{ readonly id: string }>;
  };
  readonly runs: {
    retrieve(runId: string): Promise<{ readonly id: string; readonly status: string }>;
    cancel(runId: string): Promise<unknown>;
  };
}

/** Trigger run statuses (`@trigger.dev/core` 4.6.0 `RunStatus`). */
export const triggerRunStatuses = Object.freeze([
  "PENDING_VERSION",
  "DELAYED",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
] as const);

const activeStatuses = new Set([
  "PENDING_VERSION",
  "DELAYED",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
]);
const failedStatuses = new Set(["FAILED", "CRASHED", "SYSTEM_FAILURE", "EXPIRED", "TIMED_OUT"]);

/**
 * Maps a Trigger run status to an observation (§8.1). Unknown statuses count as active, so a newer
 * platform status never interrupts a run that may still be executing.
 */
export function observeTriggerStatus(status: string): ExecutionObservation {
  if (status === "COMPLETED") return { state: "completed" };
  if (status === "CANCELED") return { state: "cancelled" };
  if (failedStatuses.has(status)) return { state: "failed", status };
  if (activeStatuses.has(status)) return { state: "active" };
  return { state: "active" };
}
