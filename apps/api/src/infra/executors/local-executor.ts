import type { ExecutionJob, ExecutionKindDefinition } from "@symplist/core/events";
import {
  errorCode,
  errorName,
  type OperationalLog,
  type RuntimeTimers,
} from "../scheduler/runtime.ts";
import type { ExecutionRegistry } from "./execution-registry.ts";
import {
  type ExecutionObservation,
  type ExecutionTarget,
  type Executor,
  ExecutorError,
  type StartedExecution,
} from "./executor.ts";

/** Why a local job's controller was aborted. */
export type LocalAbortReason = "stopped" | "switched" | "shutdown";

/** The abort reason a local handler sees on `signal.reason`. */
export class LocalExecutionAborted extends Error {
  readonly reason: LocalAbortReason;

  constructor(reason: LocalAbortReason) {
    super(`Local execution aborted (${reason})`);
    this.name = "LocalExecutionAborted";
    this.reason = reason;
  }
}

interface RunningJob {
  readonly job: ExecutionJob;
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

export interface LocalExecutorOptions {
  readonly registry: ExecutionRegistry;
  readonly timers: RuntimeTimers;
  readonly log: OperationalLog;
  /** Heartbeats are written this often for running jobs; the reconciler times out at 60 seconds. */
  readonly heartbeatIntervalMs?: number;
}

const key = (kind: string, subjectId: string) => `${kind}\u0000${subjectId}`;

/**
 * Runs jobs in the api process when `DURABLE=false` (§8.1): one handler per kind, one
 * `AbortController` per job, heartbeats through the kind's tracker, and `interrupted` when a handler
 * dies without checkpointing. It never talks to Trigger.
 */
export class LocalExecutor implements Executor {
  readonly kind = "local" as const;
  private readonly running = new Map<string, RunningJob>();
  private heartbeatTimer: unknown;
  private readonly heartbeatIntervalMs: number;
  private stopped = false;

  constructor(private readonly options: LocalExecutorOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
  }

  async start(
    job: ExecutionJob,
    _definition: ExecutionKindDefinition,
    existingTriggerRunId?: string | null,
  ): Promise<StartedExecution> {
    if (existingTriggerRunId) {
      throw new ExecutorError(
        "executor.not_configured",
        "An intent that reached Trigger is never run in process",
      );
    }
    if (this.stopped) {
      throw new ExecutorError("executor.not_configured", "The local executor is shutting down");
    }
    const handler = this.options.registry.localHandler(job.kind);
    if (!handler) {
      throw new ExecutorError("executor.handler_missing", `No local handler for ${job.kind}`);
    }
    const id = key(job.kind, job.subjectId);
    if (this.running.has(id)) return { executor: "local", triggerRunId: null };

    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => handler(job, { signal: controller.signal, generation: job.generation }))
      .then(
        () => undefined,
        (error: unknown) => this.onHandlerFailure(job, controller, error),
      )
      .finally(() => {
        this.running.delete(id);
      });
    this.running.set(id, { job, controller, done });
    this.ensureHeartbeat();
    return { executor: "local", triggerRunId: null };
  }

  async cancel(target: ExecutionTarget): Promise<void> {
    this.running
      .get(key(target.kind, target.subjectId))
      ?.controller.abort(new LocalExecutionAborted("stopped"));
  }

  async observe(target: ExecutionTarget): Promise<ExecutionObservation> {
    return this.running.has(key(target.kind, target.subjectId))
      ? { state: "active" }
      : { state: "unknown" };
  }

  isRunning(kind: string, subjectId: string): boolean {
    return this.running.has(key(kind, subjectId));
  }

  runningCount(): number {
    return this.running.size;
  }

  /** Aborts local jobs of a kind whose subject ids are listed (restriction, executor switch). */
  abortSubjects(
    kind: string | null,
    subjectIds: readonly string[],
    reason: LocalAbortReason,
  ): number {
    let aborted = 0;
    const wanted = new Set(subjectIds);
    for (const entry of this.running.values()) {
      if ((kind === null || entry.job.kind === kind) && wanted.has(entry.job.subjectId)) {
        entry.controller.abort(new LocalExecutionAborted(reason));
        aborted += 1;
      }
    }
    return aborted;
  }

  /** Writes one heartbeat batch per tracked kind for the jobs running here. */
  async heartbeat(): Promise<void> {
    const byKind = new Map<string, string[]>();
    for (const { job } of this.running.values()) {
      const list = byKind.get(job.kind) ?? [];
      list.push(job.subjectId);
      byKind.set(job.kind, list);
    }
    const now = this.options.timers.now();
    for (const [kind, subjectIds] of byKind) {
      const tracker = this.options.registry.tracker(kind);
      if (!tracker) continue;
      try {
        await tracker.recordHeartbeat(subjectIds, now);
      } catch (error) {
        this.options.log.warn("executor.heartbeat_failed", {
          kind,
          count: subjectIds.length,
          code: errorCode(error),
        });
      }
    }
  }

  /** Aborts every job with `shutdown` and waits up to `graceMs` for handlers to settle. */
  async shutdown(graceMs = 5_000): Promise<void> {
    this.stopped = true;
    this.stopHeartbeat();
    const pending = [...this.running.values()];
    for (const entry of pending) entry.controller.abort(new LocalExecutionAborted("shutdown"));
    if (pending.length === 0) return;
    let timer: unknown;
    await Promise.race([
      Promise.allSettled(pending.map((entry) => entry.done)),
      new Promise<void>((resolve) => {
        timer = this.options.timers.setTimeout(resolve, graceMs);
      }),
    ]);
    this.options.timers.clearTimeout(timer);
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = this.options.timers.setInterval(() => {
      if (this.running.size === 0) {
        this.stopHeartbeat();
        return;
      }
      void this.heartbeat();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return;
    this.options.timers.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /**
   * A handler that throws did not checkpoint its outcome. A stop becomes `stopped`; anything else
   * becomes `interrupted` with an explicit Retry. Both writes are conditional on the run still being
   * active, so a checkpoint the handler already wrote wins.
   */
  private async onHandlerFailure(
    job: ExecutionJob,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    const reason =
      controller.signal.aborted && controller.signal.reason instanceof LocalExecutionAborted
        ? controller.signal.reason.reason
        : null;
    this.options.log.warn("executor.local_handler_ended", {
      kind: job.kind,
      subjectId: job.subjectId,
      abort: reason,
      error: errorName(error),
      code: errorCode(error),
    });
    const tracker = this.options.registry.tracker(job.kind);
    if (!tracker) return;
    const now = this.options.timers.now();
    try {
      if (reason === "stopped") {
        await tracker.markStopped(job.subjectId, { now });
      } else {
        await tracker.markInterrupted(job.subjectId, {
          outcomeCode:
            reason === "switched"
              ? "executor_switched"
              : reason === "shutdown"
                ? "executor_lost"
                : "executor_error",
          now,
        });
      }
    } catch (writeError) {
      this.options.log.error("executor.local_outcome_write_failed", {
        kind: job.kind,
        subjectId: job.subjectId,
        code: errorCode(writeError),
      });
    }
  }
}
