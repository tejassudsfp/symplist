import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The executor contract (architecture §8.1, §8.3, §17): the same suite runs against the api's
 * local executor, its Trigger executor over `FakeTriggerClient`, and live Trigger when
 * `LIVE_TRIGGER=1`. It drives the whole execution path a feature relies on (dispatch intents, the
 * dispatcher, the executor of the mode, the reconciler and the executor switch) through the harness a
 * target builds, and checks what must hold in every mode: an intent starts at most one execution, an
 * execution that reached Trigger is never started again, Stop stops, a job that dies without a
 * checkpoint becomes `interrupted`, a switched generation retires its work, local mode never calls
 * Trigger and durable mode never runs job code in process.
 *
 * The suite depends only on these structural types, so any runtime can implement a target.
 */

export type ExecutorContractMode = "local" | "durable";

/** A subject's lifecycle record, as its tracker keeps it. */
export interface ExecutorContractSubject {
  readonly status: "queued" | "running" | "completed" | "stopped" | "interrupted";
  readonly outcomeCode: string | null;
}

/** What the executor of the mode reports about a subject's execution. */
export type ExecutorContractObservation =
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

/** Side effects observed on each executor since the harness was created. */
export interface ExecutorContractCounts {
  /** Job bodies started in the api process. */
  readonly inProcess: number;
  /** `tasks.trigger` requests, deduplicated ones included. */
  readonly triggerRequests: number;
  /** Distinct Trigger runs those requests created. */
  readonly triggerRuns: number;
  /** Run ids passed to `runs.cancel`, in order. */
  readonly cancelled: readonly string[];
}

export interface ExecutorContractHarness {
  readonly mode: ExecutorContractMode;
  /** Records a pending dispatch intent with a queued subject; returns the subject id. */
  record(): Promise<string>;
  /**
   * Records a pending intent that already carries a Trigger run id, as an api that crashed between
   * `tasks.trigger` and marking the intent dispatched leaves it; returns the subject id.
   */
  recordReachedTrigger(triggerRunId: string): Promise<string>;
  /** One dispatch pass; resolves with the number of intents it dispatched. */
  dispatch(): Promise<number>;
  /** Forgets the dispatch outcome of a subject: its intent is pending again behind an expired claim. */
  loseDispatchOutcome(subjectId: string): Promise<void>;
  /** One reconciliation pass. */
  reconcile(): Promise<void>;
  /** Lets started work reach its wait point: held local jobs run, queued Trigger runs start. */
  settle(): Promise<void>;
  /** Stop (§8.1): records the stop request and cancels the subject's execution. */
  stop(subjectId: string): Promise<void>;
  /** Ends a held job without a checkpoint: a thrown handler, or a crashed Trigger run. */
  crash(subjectId: string): Promise<void>;
  /** Runs `executor:switch` to the other mode. */
  switchExecutor(): Promise<void>;
  subject(subjectId: string): Promise<ExecutorContractSubject | null>;
  observe(subjectId: string): Promise<ExecutorContractObservation>;
  counts(): ExecutorContractCounts;
  close(): Promise<void>;
}

export interface ExecutorContractTarget {
  readonly name: string;
  readonly mode: ExecutorContractMode;
  /** When set the suite is skipped and the reason is shown; a skipped suite never counts as passing. */
  readonly skipReason?: string;
  /**
   * Whether the target controls job progress (holds, crashes and switches executors). Live Trigger
   * runs a deployed task the suite cannot hold, so it runs the dispatch checks only.
   */
  readonly controlledJobs: boolean;
  create(): Promise<ExecutorContractHarness>;
}

/** Outcome codes an executor writes when a job ended without its own checkpoint (§8.1). */
const interruptedOutcomes = ["executor_error", "executor_failed", "executor_lost"];

/** Registers the executor contract suite for one target. */
export function describeExecutorContract(target: ExecutorContractTarget): void {
  const title = `executor contract: ${target.name}${target.skipReason ? ` (skipped: ${target.skipReason})` : ""}`;
  describe.skipIf(target.skipReason !== undefined)(title, () => {
    let harness: ExecutorContractHarness;

    beforeEach(async () => {
      harness = await target.create();
    });

    afterEach(async () => {
      const counts = harness.counts();
      try {
        if (target.mode === "local") {
          // Local mode never needs Trigger credentials and never calls Trigger (§8.1).
          expect(counts.triggerRequests).toBe(0);
          expect(counts.cancelled).toEqual([]);
        } else {
          // Durable mode never runs model or tool code in the api (§8.1).
          expect(counts.inProcess).toBe(0);
        }
      } finally {
        await harness.close();
      }
    });

    it("starts a recorded intent exactly once, whatever later passes and reconciliation do", async () => {
      const subjectId = await harness.record();
      expect(await harness.dispatch()).toBe(1);
      await harness.settle();
      expect(await harness.dispatch()).toBe(0);
      await harness.reconcile();
      await harness.reconcile();
      const counts = harness.counts();
      if (target.mode === "local") {
        expect(counts.inProcess).toBe(1);
      } else {
        expect(counts.triggerRuns).toBe(1);
        expect(counts.triggerRequests).toBe(1);
      }
      expect(await harness.subject(subjectId)).not.toBeNull();
    });

    it.skipIf(target.mode === "local" && !target.controlledJobs)(
      "re-dispatches an intent whose dispatch outcome was lost onto the same execution",
      async () => {
        const subjectId = await harness.record();
        expect(await harness.dispatch()).toBe(1);
        await harness.settle();
        await harness.loseDispatchOutcome(subjectId);
        expect(await harness.dispatch()).toBe(1);
        await harness.settle();
        const counts = harness.counts();
        if (target.mode === "local") {
          expect(counts.inProcess).toBe(1);
        } else {
          // The Trigger idempotency key (the subject id) returns the run the first dispatch created.
          expect(counts.triggerRequests).toBe(2);
          expect(counts.triggerRuns).toBe(1);
        }
      },
    );

    it("never starts an intent that already reached Trigger again, in either executor", async () => {
      await harness.recordReachedTrigger("run_contractreached");
      expect(await harness.dispatch()).toBe(0);
      await harness.reconcile();
      expect(await harness.dispatch()).toBe(0);
      const counts = harness.counts();
      expect(counts.triggerRequests).toBe(0);
      expect(counts.inProcess).toBe(0);
    });

    it.skipIf(!target.controlledJobs)("stops a running job on Stop", async () => {
      const subjectId = await harness.record();
      await harness.dispatch();
      await harness.settle();
      expect(await harness.observe(subjectId)).toBe("active");
      await harness.stop(subjectId);
      await harness.settle();
      await harness.reconcile();
      expect(await harness.subject(subjectId)).toMatchObject({ status: "stopped" });
      if (target.mode === "durable") {
        expect(harness.counts().cancelled).toHaveLength(1);
        expect(await harness.observe(subjectId)).toBe("cancelled");
      } else {
        expect(await harness.observe(subjectId)).toBe("unknown");
      }
    });

    it.skipIf(!target.controlledJobs)(
      "marks a job that died without a checkpoint interrupted, never retrying it",
      async () => {
        const subjectId = await harness.record();
        await harness.dispatch();
        await harness.settle();
        await harness.crash(subjectId);
        await harness.settle();
        await harness.reconcile();
        const subject = await harness.subject(subjectId);
        expect(subject?.status).toBe("interrupted");
        expect(interruptedOutcomes).toContain(subject?.outcomeCode);
        await harness.reconcile();
        expect(await harness.dispatch()).toBe(0);
        const counts = harness.counts();
        expect(target.mode === "local" ? counts.inProcess : counts.triggerRuns).toBe(1);
      },
    );

    it.skipIf(!target.controlledJobs)(
      "retires the running generation on an executor switch and dispatches nothing more in the old mode",
      async () => {
        const running = await harness.record();
        await harness.dispatch();
        await harness.settle();
        const pending = await harness.record();
        await harness.switchExecutor();
        await harness.reconcile();
        await harness.settle();
        expect(await harness.subject(running)).toMatchObject({
          status: "interrupted",
          outcomeCode: "executor_switched",
        });
        expect(await harness.dispatch()).toBe(0);
        expect(await harness.subject(pending)).toMatchObject({ status: "queued" });
        const counts = harness.counts();
        if (target.mode === "local") {
          expect(counts.inProcess).toBe(1);
          expect(await harness.observe(running)).toBe("unknown");
        } else {
          expect(counts.triggerRuns).toBe(1);
          expect(counts.cancelled).toHaveLength(1);
        }
      },
    );
  });
}

/** Live Trigger settings when `LIVE_TRIGGER=1` and credentials are present; otherwise why to skip. */
export interface LiveTriggerSettings {
  /** The Trigger environment secret key the api uses (`tr_dev_…` or `tr_prod_…`). */
  readonly secretKey: string;
  /** A deployed task the suite may trigger with an ids-only payload; defaults to the healthcheck. */
  readonly taskId: string;
}

export function liveTriggerSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly settings: LiveTriggerSettings } | { readonly skipReason: string } {
  if (env.LIVE_TRIGGER !== "1") {
    return { skipReason: "set LIVE_TRIGGER=1 to run the live Trigger executor contract" };
  }
  const secretKey = env.TRIGGER_SECRET_KEY;
  if (!secretKey) return { skipReason: "LIVE_TRIGGER=1 but TRIGGER_SECRET_KEY missing" };
  return {
    settings: { secretKey, taskId: env.LIVE_TRIGGER_TASK_ID ?? "symplist-healthcheck" },
  };
}
