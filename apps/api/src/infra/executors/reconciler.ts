import {
  type ActiveExecution,
  type ExecutionTracker,
  executorKindFor,
} from "@symplist/core/events";
import { errorCode, type OperationalLog, type RuntimeTimers } from "../scheduler/runtime.ts";
import type { DispatchIntentRepository } from "./dispatch-intents.ts";
import type { ExecutionDispatcher } from "./dispatcher.ts";
import type { ExecutionRegistry } from "./execution-registry.ts";
import type { ExecutorStateReader } from "./executor-state.ts";
import type { LocalExecutor } from "./local-executor.ts";
import type { TriggerExecutor } from "./trigger-executor.ts";

export interface ReconcileReport {
  readonly ran: boolean;
  readonly rebound: number;
  readonly dispatched: number;
  readonly interrupted: number;
  readonly stopped: number;
  readonly failures: number;
}

export interface ExecutionReconcilerOptions {
  readonly state: ExecutorStateReader;
  readonly repository: DispatchIntentRepository;
  readonly registry: ExecutionRegistry;
  readonly dispatcher: ExecutionDispatcher;
  /** Present in local mode only. */
  readonly local?: LocalExecutor;
  /** Present in durable mode only, so a local-mode api never needs Trigger credentials. */
  readonly trigger?: TriggerExecutor;
  readonly timers: RuntimeTimers;
  readonly log: OperationalLog;
  readonly intervalMs?: number;
  /** A local run without a heartbeat for this long is interrupted. */
  readonly heartbeatTimeoutMs?: number;
  /** Active subjects inspected per kind per pass. */
  readonly pageSize?: number;
}

const skipped: ReconcileReport = {
  ran: false,
  rebound: 0,
  dispatched: 0,
  interrupted: 0,
  stopped: 0,
  failures: 0,
};

/**
 * The api reconciler (§8.1), every minute: re-dispatches intents that never reached Trigger (never
 * re-triggering one that did), interrupts local runs without a heartbeat for 60 seconds, and in
 * durable mode polls `runs.retrieve` for active runs, interrupting or stopping those Trigger ended.
 * It only handles runs whose executor matches the current mode.
 */
export class ExecutionReconciler {
  private timer: unknown;
  private running: Promise<ReconcileReport> | undefined;
  private readonly intervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly pageSize: number;

  constructor(private readonly options: ExecutionReconcilerOptions) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
    this.pageSize = options.pageSize ?? 100;
    const mode = options.state.configuredMode;
    if (mode === "local" && (options.trigger || !options.local)) {
      throw new Error("A local-mode reconciler uses the local executor only");
    }
    if (mode === "durable" && (options.local || !options.trigger)) {
      throw new Error("A durable-mode reconciler uses the Trigger executor only");
    }
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.options.timers.setInterval(() => {
      void this.reconcileOnce().catch(() => undefined);
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) this.options.timers.clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  reconcileOnce(): Promise<ReconcileReport> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<ReconcileReport> {
    const { state, log, timers, repository, dispatcher, registry } = this.options;
    let readiness: ReturnType<ExecutorStateReader["readiness"]>;
    try {
      readiness = state.readiness(await state.readFresh());
      // A first start whose mode could not be recorded at bootstrap (for example D1 was briefly
      // unavailable) records it here, so dispatch never stays disabled.
      if (!readiness.usable && readiness.reason === "unrecorded")
        readiness = await state.initialize();
    } catch (error) {
      log.warn("executor.reconcile_state_unavailable", { code: errorCode(error) });
      return skipped;
    }
    if (!readiness.usable) return skipped;

    let failures = 0;
    let rebound = 0;
    try {
      rebound = await repository.rebindPending({
        generation: readiness.generation,
        now: timers.now(),
      });
    } catch (error) {
      failures += 1;
      log.warn("executor.reconcile_rebind_failed", { code: errorCode(error) });
    }
    const dispatch = await dispatcher.dispatchPending();
    failures += dispatch.failed;

    let interrupted = 0;
    let stopped = 0;
    const executor = executorKindFor(readiness.mode);
    for (const { kind, tracker } of registry.trackedKinds()) {
      let active: readonly ActiveExecution[];
      try {
        active = await tracker.listActive({ executor, limit: this.pageSize });
      } catch (error) {
        failures += 1;
        log.warn("executor.reconcile_list_failed", { kind, code: errorCode(error) });
        continue;
      }
      for (const execution of active) {
        if (execution.executor !== executor) continue;
        try {
          const outcome =
            executor === "local"
              ? await this.reconcileLocal(kind, tracker, execution)
              : await this.reconcileTrigger(kind, tracker, execution);
          if (outcome === "interrupted") interrupted += 1;
          if (outcome === "stopped") stopped += 1;
        } catch (error) {
          failures += 1;
          log.warn("executor.reconcile_subject_failed", {
            kind,
            subjectId: execution.subjectId,
            code: errorCode(error),
          });
        }
      }
    }
    const report: ReconcileReport = {
      ran: true,
      rebound,
      dispatched: dispatch.dispatched,
      interrupted,
      stopped,
      failures,
    };
    if (rebound + dispatch.dispatched + interrupted + stopped + failures > 0) {
      log.info("executor.reconciled", { ...report });
    }
    return report;
  }

  private async reconcileLocal(
    kind: string,
    tracker: ExecutionTracker,
    execution: ActiveExecution,
  ): Promise<"interrupted" | "stopped" | "none"> {
    if (this.options.local?.isRunning(kind, execution.subjectId)) return "none";
    const now = this.options.timers.now();
    const lastSign = execution.heartbeatAt ?? execution.startedAt ?? execution.createdAt;
    if (now - lastSign < this.heartbeatTimeoutMs) return "none";
    const changed = await tracker.markInterrupted(execution.subjectId, {
      outcomeCode: "executor_lost",
      now,
    });
    return changed ? "interrupted" : "none";
  }

  private async reconcileTrigger(
    kind: string,
    tracker: ExecutionTracker,
    execution: ActiveExecution,
  ): Promise<"interrupted" | "stopped" | "none"> {
    const trigger = this.options.trigger;
    if (!trigger || execution.triggerRunId === null) return "none";
    const observation = await trigger.observe({
      kind,
      subjectId: execution.subjectId,
      triggerRunId: execution.triggerRunId,
    });
    if (observation.state === "active" || observation.state === "unknown") return "none";
    const now = this.options.timers.now();
    if (execution.cancelRequestedAt !== null) {
      return (await tracker.markStopped(execution.subjectId, { now })) ? "stopped" : "none";
    }
    const changed = await tracker.markInterrupted(execution.subjectId, {
      outcomeCode: "executor_failed",
      now,
    });
    if (changed) {
      this.options.log.warn("executor.trigger_run_ended", {
        kind,
        subjectId: execution.subjectId,
        triggerRunId: execution.triggerRunId,
        state: observation.state,
        status: observation.state === "failed" ? observation.status : null,
      });
    }
    return changed ? "interrupted" : "none";
  }
}
