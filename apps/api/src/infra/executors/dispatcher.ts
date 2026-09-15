import {
  type ExecutionJob,
  type ExecutionKindDefinition,
  executorKindFor,
} from "@symplist/core/events";
import { errorCode, type OperationalLog, type RuntimeTimers } from "../scheduler/runtime.ts";
import type {
  DispatchClaim,
  DispatchIntentRecord,
  DispatchIntentRepository,
} from "./dispatch-intents.ts";
import type { ExecutionRegistry } from "./execution-registry.ts";
import type { Executor, StartedExecution } from "./executor.ts";
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
 *
 * An intent starts at most one execution even when its dispatch outcome is lost (a failed
 * `markDispatched`, or a claim another pass took over after the lease): durable work relies on
 * Trigger's idempotency key (the subject id), and local work on a start marker written to the intent,
 * conditional on the claim, before the job runs. A claimed intent that already carries the marker is
 * marked dispatched without starting again; if its api died before the job ran, the reconciler
 * interrupts the subject for want of a heartbeat, because the subject records the local executor
 * before the job starts.
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
        let dispatchClaim: DispatchClaim = claim;
        let started: StartedExecution;
        if (executor.kind === "local") {
          const local = await this.startLocally(claim, job, definition);
          if (!local) {
            skipped += 1;
            log.warn("executor.dispatch_claim_lost", { kind: intent.kind, intentId: intent.id });
            continue;
          }
          dispatchClaim = local.claim;
          started = local.started;
        } else {
          started = await executor.start(job, definition, claim.intent.triggerRunId);
        }
        const now = timers.now();
        const marked = await repository.markDispatched(dispatchClaim, {
          triggerRunId: started.triggerRunId,
          now,
        });
        if (!marked) {
          skipped += 1;
          log.warn("executor.dispatch_claim_lost", { kind: intent.kind, intentId: intent.id });
          continue;
        }
        // Local subjects recorded their executor before the job started.
        if (executor.kind !== "local") {
          await registry.tracker(intent.kind)?.recordDispatch(intent.subjectId, {
            executor: started.executor,
            triggerRunId: started.triggerRunId,
            generation: readiness.generation,
            now,
          });
        }
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
   * Starts a claimed intent in the api process at most once (§8.1). An intent that already carries the
   * start marker landed on the execution an earlier pass started, so it is not started again. Otherwise
   * the marker is written (conditional on the claim), the subject records the local executor, and only
   * then the job starts; a start that throws before any job code ran clears the marker again. Returns
   * null when the claim was lost before the marker was written.
   */
  private async startLocally(
    claim: DispatchClaim,
    job: ExecutionJob,
    definition: ExecutionKindDefinition,
  ): Promise<{ readonly claim: DispatchClaim; readonly started: StartedExecution } | null> {
    const { repository, registry, executor, timers, log } = this.options;
    const tracker = registry.tracker(job.kind);
    const recordLocal = () =>
      tracker?.recordDispatch(job.subjectId, {
        executor: "local",
        triggerRunId: null,
        generation: job.generation,
        now: timers.now(),
      });
    if (claim.intent.localStartedAt !== null) {
      log.info("executor.dispatch_deduplicated", {
        kind: job.kind,
        intentId: job.intentId,
        subjectId: job.subjectId,
        executor: "local",
      });
      await recordLocal();
      return { claim, started: { executor: "local", triggerRunId: null } };
    }
    const marked = await repository.markLocalStart(claim, { now: timers.now() });
    if (!marked) return null;
    try {
      await recordLocal();
      return { claim: marked, started: await executor.start(job, definition, null) };
    } catch (error) {
      try {
        await repository.releaseLocalStart(marked, { now: timers.now() });
      } catch (releaseError) {
        // The marker stays: the intent is never started in process, and the reconciler interrupts
        // its subject once it has gone without a heartbeat.
        log.warn("executor.local_start_release_failed", {
          kind: job.kind,
          intentId: job.intentId,
          code: errorCode(releaseError),
        });
      }
      throw error;
    }
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
