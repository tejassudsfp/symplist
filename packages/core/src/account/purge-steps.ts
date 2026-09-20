import type { ActiveExecution, ExecutionTracker, ExecutorKind } from "../events/execution.ts";
import type { AccountPurgeExternalStep } from "./purge.ts";
import { purgeContributors as defaultContributors } from "./purge-contributors/index.ts";
import type { PurgeContributor, PurgeProviderDependencies } from "./purge-contributors/types.ts";

/**
 * The purge steps that run outside D1 and R2 (§5.6 steps 1 and 2), built from the registries every
 * runtime shares: the execution kinds of the core events contributors (their trackers own the run
 * lifecycles) and the purge contributors. The api builds them for `DURABLE=false` and the
 * `account-purge` Trigger task for `DURABLE=true`, so both runtimes purge identically.
 */

/**
 * §5.6 step 2: every purge contributor's provider-side deletion, in registry order. A domain with no
 * account state at a provider contributes nothing; the step is done once every contributing domain
 * reported done.
 */
export function providerPurgeStep(options: {
  readonly dependencies: PurgeProviderDependencies;
  readonly contributors?: readonly PurgeContributor[];
}): AccountPurgeExternalStep {
  const contributors = options.contributors ?? defaultContributors;
  return {
    async run(input) {
      let complete = true;
      for (const contributor of contributors) {
        if (!contributor.purgeProvider) continue;
        const outcome = await contributor.purgeProvider(input, options.dependencies);
        if (outcome !== "done") complete = false;
      }
      return complete ? "done" : "incomplete";
    },
  };
}

/** A dispatch intent kind whose subjects have a lifecycle, with its tracker. */
export interface TrackedExecutionKind {
  readonly kind: string;
  readonly tracker: ExecutionTracker;
}

/** An active execution together with its intent kind. */
export type KindedExecution = ActiveExecution & { readonly kind: string };

export interface StragglerRunsStepOptions {
  readonly trackedKinds: readonly TrackedExecutionKind[];
  /** The executor this runtime drives: `local` in the api when `DURABLE=false`, `trigger` otherwise. */
  readonly executor: ExecutorKind;
  /**
   * Stops one active execution of `executor`: aborts the in-process job or calls Trigger
   * `runs.cancel`. Throws when it could not, which leaves the step unrecorded for the next attempt.
   */
  readonly cancel: (execution: KindedExecution) => Promise<void>;
  readonly now: () => number;
  /** Subjects listed per request; defaults to 100. */
  readonly pageSize?: number;
  /** Pages read per kind and executor in one invocation; defaults to 10. */
  readonly maxPages?: number;
}

const executorKinds: readonly ExecutorKind[] = ["local", "trigger"];

/**
 * §5.6 step 1: confirms no active runs of the deleted account remain and cancels stragglers. The
 * deletion batch already requested their stop (§5.5), so each active execution of this runtime's
 * executor is stopped here and marked `stopped`. Active executions of the other executor cannot be
 * reached from this runtime; they keep the step incomplete until the executor switch, which
 * interrupts every old-executor run, has cleared them (§8.1).
 */
export function stragglerRunsPurgeStep(
  options: StragglerRunsStepOptions,
): AccountPurgeExternalStep {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 10;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("pageSize must be a positive integer");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RangeError("maxPages must be a positive integer");
  }
  return {
    async run({ userId }) {
      let remaining = false;
      for (const { kind, tracker } of options.trackedKinds) {
        for (const executor of executorKinds) {
          let after: string | undefined;
          let pages = 0;
          for (;;) {
            if (pages >= maxPages) {
              remaining = true;
              break;
            }
            pages += 1;
            const page = await tracker.listActive({
              executor,
              limit: pageSize,
              ownerId: userId,
              ...(after === undefined ? {} : { after }),
            });
            for (const execution of page) {
              // The owner filter is the tracker's; a foreign subject is never touched.
              if (execution.ownerId !== userId || execution.executor !== executor) continue;
              if (executor !== options.executor) {
                remaining = true;
                continue;
              }
              await options.cancel({ ...execution, kind });
              await tracker.markStopped(execution.subjectId, { now: options.now() });
            }
            const last = page.at(-1);
            if (page.length < pageSize || last === undefined) break;
            after = last.subjectId;
          }
        }
      }
      return remaining ? "incomplete" : "done";
    },
  };
}
