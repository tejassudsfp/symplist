import type { DbClient } from "@symplist/db";

/**
 * Execution seams shared by the api executors, the executor switch and the features that own
 * dispatched work (§8.1). The executors never read feature tables directly: each dispatch intent kind
 * supplies a definition with its Trigger task, ids-only payload and an optional lifecycle tracker.
 */

/** `executor_state.mode`: which runtime executes durable work (§8.1). */
export type ExecutorMode = "local" | "durable";

/** `runs.executor` and `dispatch_intents.executor`. */
export type ExecutorKind = "local" | "trigger";

export const executorModes: readonly ExecutorMode[] = Object.freeze(["local", "durable"]);

/** The executor kind that runs work in a mode. */
export function executorKindFor(mode: ExecutorMode): ExecutorKind {
  return mode === "durable" ? "trigger" : "local";
}

/** `runs.status` values (§8.1). */
export const runLifecycleStatuses = Object.freeze([
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_user",
  "completed",
  "stopped",
  "interrupted",
  "failed",
] as const);

export type RunLifecycleStatus = (typeof runLifecycleStatuses)[number];

/** Statuses in which a run holds an executor (§8.1). */
export const executingRunStatuses: readonly RunLifecycleStatus[] = Object.freeze([
  "queued",
  "running",
]);

/** One unit of dispatched work, built from a `dispatch_intents` row. Ids only. */
export interface ExecutionJob {
  readonly intentId: string;
  /** `dispatch_intents.kind`, for example `simon_run` or `account_purge`. */
  readonly kind: string;
  /** The Trigger idempotency key: the run id for `simon_run`, the user id for `account_purge`. */
  readonly subjectId: string;
  readonly ownerId: string;
  /** The executor generation the work was dispatched under; every step compares it (§8.1). */
  readonly generation: number;
  /**
   * `dispatch_intents.session_external_id`: the durable session this work joins. It outlives the
   * subject — for `simon_run` the subject is one run and this is its conversation — so a session
   * started for an earlier subject answers this one. Null for kinds that run no session.
   */
  readonly sessionExternalId: string | null;
}

export interface LocalExecutionContext {
  /** Aborted by Stop, an executor switch or api shutdown. */
  readonly signal: AbortSignal;
  readonly generation: number;
}

/** Runs one job in the api process when `DURABLE=false`, calling the same service as the Trigger task. */
export type LocalExecutionHandler = (
  job: ExecutionJob,
  context: LocalExecutionContext,
) => Promise<void>;

/** `runs.outcome_code` values the executors write when they end a run they no longer execute. */
export type ExecutionOutcomeCode =
  /** A local run without a heartbeat for 60 seconds, for example after an api restart. */
  | "executor_lost"
  /** Trigger reported FAILED, CRASHED, SYSTEM_FAILURE, EXPIRED, TIMED_OUT, CANCELED or COMPLETED without a checkpoint. */
  | "executor_failed"
  /** The executor switch moved the generation while the run was active. */
  | "executor_switched"
  /** A local handler threw instead of checkpointing its own outcome. */
  | "executor_error"
  /** Stable model availability/outcome codes; never a provider exception message. */
  | "ai.unavailable"
  | "ai.provider_failed"
  /**
   * The account has no usable model key (§8.6).
   *
   * Distinct from `ai.unavailable`, which says the deployment cannot run models at all. This one is
   * the owner's to fix and is fixed in one place, so it travels separately all the way to the
   * screen rather than being flattened into a generic failure the reader can only retry.
   */
  | "ai.key_required";

/** One active subject (for Simon: a `queued` or `running` run) as the executors see it. */
export interface ActiveExecution {
  readonly subjectId: string;
  readonly ownerId: string;
  readonly executor: ExecutorKind;
  readonly executorGeneration: number;
  readonly triggerRunId: string | null;
  /** UTC epoch milliseconds of the last heartbeat, if any. */
  readonly heartbeatAt: number | null;
  readonly startedAt: number | null;
  readonly createdAt: number;
  readonly cancelRequestedAt: number | null;
}

/**
 * Lifecycle operations on the subjects of one dispatch intent kind (§8.1). Every write is a single
 * conditional statement on the subject's current status, verified by write id, so a checkpoint the
 * worker wrote first always wins.
 */
export interface ExecutionTracker {
  /**
   * Active subjects run by `executor`, ordered by subject id, after `after` when given. With
   * `ownerId`, only that owner's subjects: the restriction canceller and the account purge list one
   * user's work without scanning everyone's.
   */
  listActive(query: {
    readonly executor: ExecutorKind;
    readonly limit: number;
    readonly after?: string;
    readonly ownerId?: string;
  }): Promise<readonly ActiveExecution[]>;
  /**
   * Records which executor took the subject and its Trigger run id: after the intent is dispatched to
   * Trigger, or, for the local executor, just before the job starts in process (so a start lost with
   * its api is reconciled). Idempotent: the dispatcher may record the same dispatch again.
   */
  recordDispatch(
    subjectId: string,
    dispatch: {
      readonly executor: ExecutorKind;
      readonly triggerRunId: string | null;
      readonly generation: number;
      readonly now: number;
    },
  ): Promise<void>;
  /** Writes the heartbeat of subjects running in this api process (one batch). */
  recordHeartbeat(subjectIds: readonly string[], now: number): Promise<void>;
  /** Marks an active subject `interrupted` with an explicit Retry; false when it was no longer active. */
  markInterrupted(
    subjectId: string,
    outcome: { readonly outcomeCode: ExecutionOutcomeCode; readonly now: number },
  ): Promise<boolean>;
  /** Marks an active subject whose stop was requested `stopped`; false when it was no longer active. */
  markStopped(subjectId: string, outcome: { readonly now: number }): Promise<boolean>;
}

/** Dependencies a tracker or relay source is built with. */
export interface ExecutionSeamDependencies {
  readonly db: DbClient;
  readonly betaAccessRequired?: boolean;
}

/** A dispatch intent kind: how it runs durably and how its subjects are reconciled (§8.1, §8.8). */
export interface ExecutionKindDefinition {
  readonly kind: string;
  /** The Trigger task id, for example `simon-run`. */
  readonly triggerTaskId: string;
  /** The Trigger payload: ids only (§8.3), for example `{ runId }`. */
  payload(job: ExecutionJob): Readonly<Record<string, string>>;
  /**
   * The `chat.agent` task that runs this kind's work inside a durable session, for example
   * `simon-chat`. A kind without one always runs `triggerTaskId`.
   */
  readonly sessionTaskId?: string;
  /**
   * The session's external id: the identity the session spans. Never the subject id, because a
   * session outlives one subject, and null when this job has no session — the dispatch then falls
   * back to `triggerTaskId`.
   */
  sessionExternalId?(job: ExecutionJob): string | null;
  /** Kinds whose subjects have a lifecycle (runs) supply a tracker for reconciliation and switching. */
  tracker?(dependencies: ExecutionSeamDependencies): ExecutionTracker;
}

/** Immutable ownership of a run, cached by the api for the run's life (§6.2). */
export interface RunRelayOwnership {
  readonly runId: string;
  readonly ownerId: string;
  readonly conversationId: string;
}

/** The mutable run fields the api re-reads at most every 10 seconds before relaying output (§6.2). */
export interface RunRelayState {
  readonly status: RunLifecycleStatus;
  readonly executorGeneration: number;
}

/** Reads the fields the run output relay needs from `runs` (owned by Simon, §8.2). */
export interface RunRelaySource {
  ownership(runId: string): Promise<RunRelayOwnership | null>;
  state(runId: string): Promise<RunRelayState | null>;
}
