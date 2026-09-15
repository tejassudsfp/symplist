import { type ExecutionJob, executorKindFor } from "@symplist/core/events";
import { errorCode, type OperationalLog, type RuntimeTimers } from "../scheduler/runtime.ts";
import type { DispatchIntentRecord, DispatchIntentRepository } from "./dispatch-intents.ts";
import type { ExecutionRegistry } from "./execution-registry.ts";
import type { Executor } from "./executor.ts";
import type { ExecutorStateReader } from "./executor-state.ts";

export interface DispatchReport {
  readonly considered: number;
  readonly dispatched: number;
  readonly failed: number;
  /** Intents skipped because another claim holds them, their kind is unknown, or the mode differs. */
  readonly skipped: number;
}

export interface ExecutionDispatcherOptions {
  readonly repository: DispatchIntentRepository;
  readonly state: ExecutorStateReader;
  readonly registry: ExecutionRegistry;
  /** The executor of the configured mode: local when `DURABLE=false`, Trigger when true. */
  readonly executor: Executor;
  readonly timers: RuntimeTimers;
  readonly log: OperationalLog;
  /** A claimed intent that was not marked dispatched may be claimed again after this long. */
  readonly claimLeaseMs?: number;
  readonly batchSize?: number;
}

const emptyReport: DispatchReport = { considered: 0, dispatched: 0, failed: 0, skipped: 0 };

/**
 * Picks pending dispatch intents after commit (§8.1): reads the executor generation fresh, claims
 * each intent with a write id, starts it on the configured executor and stores the Trigger run id.
 * Only the executor of the configured mode is ever called.
 */
export class ExecutionDispatcher {
  private running: Promise<DispatchReport> | undefined;
  private again = false;
  private kickTimer: unknown;
  private closed = false;
  private readonly claimLeaseMs: number;
  private readonly batchSize: number;

  constructor(private readonly options: ExecutionDispatcherOptions) {
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
    this.batchSize = options.batchSize ?? 25;
    const expected = executorKindFor(options.state.configuredMode);
    if (options.executor.kind !== expected) {
      throw new Error(
        `The ${options.state.configuredMode} mode dispatches only to the ${expected} executor`,
      );
    }
  }

  /** Schedules a dispatch pass soon; features call it after committing an intent. */
  kick(): void {
    if (this.closed || this.kickTimer !== undefined) return;
    this.kickTimer = this.options.timers.setTimeout(() => {
      this.kickTimer = undefined;
      void this.dispatchPending().catch(() => undefined);
    }, 0);
  }

  /** Runs one dispatch pass; concurrent calls share it and trigger one more pass afterwards. */
  dispatchPending(): Promise<DispatchReport> {
    if (this.closed) return Promise.resolve(emptyReport);
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass().finally(() => {
      this.running = undefined;
      if (this.again && !this.closed) {
        this.again = false;
        this.kick();
      }
    });
    return this.running;
  }

  /** Stops scheduling passes and waits for a pass in progress. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.kickTimer !== undefined) this.options.timers.clearTimeout(this.kickTimer);
    this.kickTimer = undefined;
    await this.running?.catch(() => undefined);
  }

  private async pass(): Promise<DispatchReport> {
    const { repository, registry, executor, log, timers } = this.options;
    let state: Awaited<ReturnType<ExecutorStateReader["readFresh"]>>;
    try {
      state = await this.options.state.readFresh();
    } catch (error) {
      log.warn("executor.dispatch_state_unavailable", { code: errorCode(error) });
      return emptyReport;
    }
    const readiness = this.options.state.readiness(state);
    if (!readiness.usable) return emptyReport;

    let intents: readonly DispatchIntentRecord[];
    try {
      intents = await repository.listDispatchable({
        generation: readiness.generation,
        now: timers.now(),
        claimLeaseMs: this.claimLeaseMs,
        limit: this.batchSize,
      });
    } catch (error) {
      log.warn("executor.dispatch_list_failed", { code: errorCode(error) });
      return emptyReport;
    }

    let dispatched = 0;
    let failed = 0;
    let skipped = 0;
    for (const intent of intents) {
      if (this.closed) break;
      const definition = registry.definition(intent.kind);
      if (!definition) {
        skipped += 1;
        log.warn("executor.dispatch_kind_unknown", { kind: intent.kind, intentId: intent.id });
        continue;
      }
      try {
        const claim = await repository.claim(intent, {
          executor: executor.kind,
          generation: readiness.generation,
          now: timers.now(),
          claimLeaseMs: this.claimLeaseMs,
        });
        if (!claim) {
          skipped += 1;
          continue;
        }
        const job: ExecutionJob = {
          intentId: intent.id,
          kind: intent.kind,
          subjectId: intent.subjectId,
          ownerId: intent.ownerId,
          generation: readiness.generation,
        };
        const started = await executor.start(job, definition, claim.intent.triggerRunId);
        const now = timers.now();
        const marked = await repository.markDispatched(claim, {
          triggerRunId: started.triggerRunId,
          now,
        });
        if (!marked) {
          skipped += 1;
          log.warn("executor.dispatch_claim_lost", { kind: intent.kind, intentId: intent.id });
          continue;
        }
        await registry.tracker(intent.kind)?.recordDispatch(intent.subjectId, {
          executor: started.executor,
          triggerRunId: started.triggerRunId,
          generation: readiness.generation,
          now,
        });
        dispatched += 1;
        log.info("executor.dispatched", {
          kind: intent.kind,
          intentId: intent.id,
          subjectId: intent.subjectId,
          executor: started.executor,
          triggerRunId: started.triggerRunId,
          generation: readiness.generation,
        });
      } catch (error) {
        failed += 1;
        log.warn("executor.dispatch_failed", {
          kind: intent.kind,
          intentId: intent.id,
          code: errorCode(error),
        });
      }
    }
    return { considered: intents.length, dispatched, failed, skipped };
  }

  /**
   * Stops one subject (§8.1 Stop): aborts a local job, or cancels the stored Trigger run. The caller
   * has already set `cancel_requested_at` in D1.
   */
  async cancel(kind: string, subjectId: string): Promise<void> {
    const intent = await this.options.repository.findBySubject(kind, subjectId);
    await this.options.executor.cancel({
      kind,
      subjectId,
      triggerRunId: intent?.triggerRunId ?? null,
    });
  }
}
