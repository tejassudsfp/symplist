import { type ExecutorKind, type ExecutorMode, executorKindFor } from "@symplist/core/events";
import type { DbClient } from "@symplist/db";
import { errorCode, type OperationalLog } from "../scheduler/runtime.ts";
import { DispatchIntentRepository } from "./dispatch-intents.ts";
import type { ExecutionRegistry } from "./execution-registry.ts";
import { ExecutorError, type TriggerRunsClient } from "./executor.ts";
import { ExecutorStateRepository } from "./executor-state.ts";

export interface ExecutorSwitchReport {
  readonly from: ExecutorMode | null;
  readonly to: ExecutorMode;
  /** False when the mode was already the target; the completion steps still ran. */
  readonly advanced: boolean;
  readonly generation: number;
  readonly interrupted: number;
  readonly cancelledTriggerRuns: number;
  readonly cancelFailures: number;
  readonly rebound: number;
}

export interface ExecutorSwitchOptions {
  readonly db: DbClient;
  readonly registry: ExecutionRegistry;
  /** Required whenever durable work may be active (leaving durable mode or completing a switch). */
  readonly trigger: TriggerRunsClient | null;
  readonly now: () => number;
  readonly log: OperationalLog;
  readonly pageSize?: number;
}

/**
 * `executor:switch --to local|durable` (§8.1): advances the executor generation, cancels the old
 * executor's active runs (calling Trigger `runs.cancel` when leaving durable mode) and marks them
 * `interrupted` with Retry, then rebinds pending intents to the new generation so the executor of the
 * new mode dispatches them. Every step after the generation advance is idempotent, so re-running the
 * command completes an interrupted switch.
 */
export class ExecutorSwitch {
  private readonly state: ExecutorStateRepository;
  private readonly intents: DispatchIntentRepository;
  private readonly pageSize: number;

  constructor(private readonly options: ExecutorSwitchOptions) {
    this.state = new ExecutorStateRepository(options.db);
    this.intents = new DispatchIntentRepository(options.db);
    this.pageSize = options.pageSize ?? 100;
  }

  async switchTo(target: ExecutorMode): Promise<ExecutorSwitchReport> {
    if (target !== "local" && target !== "durable") {
      throw new ExecutorError(
        "executor.not_configured",
        "The target mode must be local or durable",
      );
    }
    const before = await this.state.read();
    const oldExecutors: readonly ExecutorKind[] =
      before.mode === null ? ["local", "trigger"] : [executorKindFor(before.mode)];
    const retired = oldExecutors.filter((executor) => executor !== executorKindFor(target));
    if (retired.includes("trigger") && !this.options.trigger) {
      throw new ExecutorError(
        "executor.not_configured",
        "Cancelling durable runs needs TRIGGER_SECRET_KEY in the environment",
      );
    }

    let generation = before.generation;
    let advanced = false;
    if (before.mode !== target) {
      const after = await this.state.advance({
        expectedGeneration: before.generation,
        mode: target,
        now: this.options.now(),
      });
      if (!after) {
        throw new ExecutorError(
          "executor.switch_conflict",
          "The executor generation changed during the switch; run the command again",
        );
      }
      generation = after.generation;
      advanced = true;
      this.options.log.info("executor.switched", {
        from: before.mode,
        to: target,
        generation,
      });
    }

    let interrupted = 0;
    let cancelledTriggerRuns = 0;
    let cancelFailures = 0;
    for (const executor of retired) {
      const result = await this.retire(executor);
      interrupted += result.interrupted;
      cancelledTriggerRuns += result.cancelled;
      cancelFailures += result.cancelFailures;
    }
    const rebound = await this.intents.rebindPending({ generation, now: this.options.now() });
    return {
      from: before.mode,
      to: target,
      advanced,
      generation,
      interrupted,
      cancelledTriggerRuns,
      cancelFailures,
      rebound,
    };
  }

  private async retire(
    executor: ExecutorKind,
  ): Promise<{ interrupted: number; cancelled: number; cancelFailures: number }> {
    let interrupted = 0;
    let cancelled = 0;
    let cancelFailures = 0;
    for (const { kind, tracker } of this.options.registry.trackedKinds()) {
      // Pages are ordered by subject id; `after` moves past every subject already handled, whether
      // its interruption applied or it ended concurrently.
      let after: string | undefined;
      for (;;) {
        const page = await tracker.listActive({
          executor,
          limit: this.pageSize,
          ...(after === undefined ? {} : { after }),
        });
        if (page.length === 0) break;
        for (const execution of page) {
          after = execution.subjectId;
          if (execution.executor !== executor) continue;
          if (executor === "trigger" && execution.triggerRunId !== null) {
            try {
              await this.options.trigger?.runs.cancel(execution.triggerRunId);
              cancelled += 1;
            } catch (error) {
              cancelFailures += 1;
              this.options.log.warn("executor.switch_cancel_failed", {
                kind,
                subjectId: execution.subjectId,
                triggerRunId: execution.triggerRunId,
                code: errorCode(error),
              });
            }
          }
          const changed = await tracker.markInterrupted(execution.subjectId, {
            outcomeCode: "executor_switched",
            now: this.options.now(),
          });
          if (changed) interrupted += 1;
        }
        if (page.length < this.pageSize) break;
      }
    }
    return { interrupted, cancelled, cancelFailures };
  }
}
