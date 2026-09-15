import { idSchema } from "@symplist/contracts";
import {
  ACCOUNT_PURGE_INTENT_KIND,
  AccountPurgeRunner,
  type PurgeContributor,
  providerPurgeStep,
  purgeContributors,
  stragglerRunsPurgeStep,
  type TrackedExecutionKind,
} from "@symplist/core/account";
import {
  collectExecutionKinds,
  type EventsContributor,
  eventsContributors,
} from "@symplist/core/events";
import { type DbClient, sql } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { z } from "zod";
import { WorkerError, withMappedErrors } from "./errors.ts";
import type { WorkerLogger } from "./logger.ts";
import { sleep, systemWorkerTimers, type WorkerTimers } from "./timers.ts";

/** The ids-only payload of the `account-purge` task (§5.6, §8.3), set by the api dispatcher. */
export const accountPurgePayloadSchema = z.strictObject({ userId: idSchema });

export type AccountPurgePayload = z.infer<typeof accountPurgePayloadSchema>;

/** The task output: enums and counts only (§8.3). */
export interface AccountPurgeTaskOutput {
  /** `skipped`: the executor generation moved or durable mode ended, so this run wrote nothing. */
  readonly status: "done" | "not_found" | "skipped";
  readonly invocationCount: number;
}

/** The Trigger SDK surface the purge uses: `runs.cancel` with the platform-injected key (§4.5). */
export interface AccountPurgeTriggerRuns {
  cancel(runId: string): Promise<unknown>;
}

export interface AccountPurgeTaskDependencies {
  readonly db: DbClient;
  readonly objects: ObjectStore;
  readonly runs: AccountPurgeTriggerRuns;
  readonly logger: WorkerLogger;
  readonly timers?: WorkerTimers;
  /** Defaults to the core events contributors; their trackers find straggler runs. */
  readonly eventsContributors?: readonly EventsContributor[];
  /** Defaults to the registered purge contributors (§2.3). */
  readonly purgeContributors?: readonly PurgeContributor[];
  /**
   * How long one attempt keeps running bounded purge invocations before it asks Trigger to retry;
   * defaults to 10 minutes, inside the task's 15-minute `maxDuration`.
   */
  readonly budgetMs?: number;
  /**
   * The pause between invocations that left the purge incomplete, so work that cannot progress yet
   * (runs of another executor, a provider asking to wait) is not polled in a tight loop; defaults to
   * 5 seconds.
   */
  readonly pauseMs?: number;
}

/**
 * Whether this run may still purge: `executor_state` records durable mode and the `account_purge`
 * intent was dispatched under the current generation (§8.1). After an executor switch the api's local
 * purge takes over, and a straggling Trigger attempt must exit without writing.
 */
async function generationIsCurrent(db: DbClient, userId: string): Promise<boolean> {
  const row = await db.first<{ mode: string | null; generation: number; intent: number | null }>(
    sql(
      `SELECT e.mode, e.generation,
              (SELECT executor_generation FROM dispatch_intents
               WHERE kind = :kind AND subject_id = :user) AS intent
       FROM executor_state e WHERE e.id = 1`,
      { kind: ACCOUNT_PURGE_INTENT_KIND, user: userId },
    ),
  );
  return (
    row?.mode === "durable" && row.intent !== null && Number(row.intent) === Number(row.generation)
  );
}

/**
 * The Trigger run id the dispatched intent recorded for a subject whose run record missed it (the
 * dispatcher stores it on the intent first, §8.1), or null when the subject never reached Trigger.
 */
async function intentTriggerRunId(
  db: DbClient,
  execution: { readonly kind: string; readonly subjectId: string },
): Promise<string | null> {
  const row = await db.first<{ trigger_run_id: string | null }>(
    sql(
      `SELECT trigger_run_id FROM dispatch_intents
       WHERE kind = :kind AND subject_id = :subject AND executor = 'trigger'`,
      { kind: execution.kind, subject: execution.subjectId },
    ),
  );
  return row?.trigger_run_id ?? null;
}

/**
 * The durable account purge (§5.6, §8.8): the same `AccountPurgeRunner` the api runs in local mode,
 * with straggler runs cancelled through Trigger `runs.cancel` and provider state purged through the
 * purge contributors. It needs nothing the crypto-shred destroyed, records every finished step, and
 * repeats bounded invocations while its time budget lasts, checking the executor generation before
 * each. A purge still incomplete at the end of the budget throws the retryable
 * `account_purge.incomplete`, so Trigger's explicit retry resumes it from the recorded steps.
 */
export async function runAccountPurgeTask(
  payload: unknown,
  dependencies: AccountPurgeTaskDependencies,
  signal?: AbortSignal,
): Promise<AccountPurgeTaskOutput> {
  const parsed = accountPurgePayloadSchema.safeParse(payload);
  if (!parsed.success) throw new WorkerError("account_purge.payload_invalid");
  const { userId } = parsed.data;
  const { db, logger } = dependencies;
  const timers = dependencies.timers ?? systemWorkerTimers;
  const now = () => timers.now();
  const trackedKinds: TrackedExecutionKind[] = [];
  for (const definition of collectExecutionKinds(
    dependencies.eventsContributors ?? eventsContributors,
  ).values()) {
    const tracker = definition.tracker?.({ db });
    if (tracker) trackedKinds.push({ kind: definition.kind, tracker });
  }
  const runner = new AccountPurgeRunner({
    db,
    store: dependencies.objects,
    now,
    runs: stragglerRunsPurgeStep({
      trackedKinds,
      executor: "trigger",
      now,
      cancel: async (execution) => {
        const triggerRunId = execution.triggerRunId ?? (await intentTriggerRunId(db, execution));
        // A run that never reached Trigger has nothing to cancel there.
        if (triggerRunId === null) return;
        await withMappedErrors(() => dependencies.runs.cancel(triggerRunId));
      },
    }),
    composio: providerPurgeStep({
      dependencies: { db, now },
      contributors: dependencies.purgeContributors ?? purgeContributors,
    }),
    ...(dependencies.purgeContributors ? { contributors: dependencies.purgeContributors } : {}),
  });

  const deadline = now() + (dependencies.budgetMs ?? 10 * 60_000);
  let invocations = 0;
  return withMappedErrors(async () => {
    for (;;) {
      if (signal?.aborted) throw new WorkerError("run.aborted");
      if (!(await generationIsCurrent(db, userId))) {
        logger.warn("account_purge.skipped_generation", { userId, invocationCount: invocations });
        return { status: "skipped", invocationCount: invocations };
      }
      invocations += 1;
      const result = await runner.run(userId);
      if (result.status !== "incomplete") {
        logger.info("account_purge.finished", {
          userId,
          status: result.status,
          invocationCount: invocations,
        });
        return { status: result.status, invocationCount: invocations };
      }
      if (now() >= deadline) {
        logger.warn("account_purge.incomplete", {
          userId,
          invocationCount: invocations,
          stepCount: result.stepsDone.length,
        });
        throw new WorkerError("account_purge.incomplete", true);
      }
      await sleep(timers, Math.min(dependencies.pauseMs ?? 5_000, Math.max(0, deadline - now())));
    }
  });
}
