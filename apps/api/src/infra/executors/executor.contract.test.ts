import type { ExecutionKindDefinition } from "@symplist/core/events";
import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  newWriteId,
  sql,
  uuidv7,
} from "@symplist/db";
import {
  describeExecutorContract,
  type ExecutorContractHarness,
  type ExecutorContractObservation,
  FakeClock,
  FakeTriggerClient,
  liveTriggerSettings,
} from "@symplist/testing";
import { FakeTracker } from "../../../test/executors/memory-tracker.ts";
import type { OperationalLog } from "../scheduler/runtime.ts";
import { DispatchIntentRepository, insertDispatchIntentStatement } from "./dispatch-intents.ts";
import { ExecutionDispatcher } from "./dispatcher.ts";
import { ExecutionRegistry } from "./execution-registry.ts";
import type { Executor, TriggerRunsClient } from "./executor.ts";
import { ExecutorStateRepository, ExecutorStateService } from "./executor-state.ts";
import { ExecutorSwitch } from "./executor-switch.ts";
import { LocalExecutor } from "./local-executor.ts";
import { ExecutionReconciler } from "./reconciler.ts";
import { TriggerExecutor } from "./trigger-executor.ts";
import { createTriggerRunsClient } from "./trigger-sdk-client.ts";

const KIND = "contract_job";
const OWNER = "01996d2a-4c00-7000-8000-00000000f001";
const CLAIM_LEASE_MS = 60_000;

const silentLog: OperationalLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A Trigger client that records every request, over the fake or the live SDK client. */
function countingTrigger(inner: TriggerRunsClient) {
  const requests: string[] = [];
  const cancelled: string[] = [];
  const client: TriggerRunsClient = {
    tasks: {
      trigger: async (taskIdentifier, payload, options) => {
        const handle = await inner.tasks.trigger(taskIdentifier, payload, options);
        requests.push(handle.id);
        return handle;
      },
    },
    runs: {
      retrieve: (runId) => inner.runs.retrieve(runId),
      cancel: async (runId) => {
        cancelled.push(runId);
        return inner.runs.cancel(runId);
      },
    },
    sessions: {
      start: async (input) => {
        const started = await inner.sessions.start(input);
        requests.push(started.runId);
        return started;
      },
      append: (externalId, record) => inner.sessions.append(externalId, record),
      currentRunId: (externalId) => inner.sessions.currentRunId(externalId),
    },
  };
  return { client, requests, cancelled };
}

interface HarnessOptions {
  readonly mode: "local" | "durable";
  /** The Trigger client the api would hold; in local mode only the executor switch may receive it. */
  readonly trigger: TriggerRunsClient;
  readonly taskId: string;
  /** The fake Trigger client behind `trigger`, when the target controls runs. */
  readonly fake?: FakeTriggerClient;
  readonly clock: FakeClock;
}

/**
 * The api's execution path for one mode: dispatch intents in D1, the dispatcher, the executor of the
 * mode, the reconciler and the executor switch, with an in-memory tracker for the probe kind.
 */
async function createHarness(options: HarnessOptions): Promise<ExecutorContractHarness> {
  const { mode, clock, fake } = options;
  const db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  await db.run(
    sql("UPDATE executor_state SET mode = :mode, write_id = :w WHERE id = 1", {
      mode,
      w: newWriteId(),
    }),
  );
  const tracker = new FakeTracker();
  const definition: ExecutionKindDefinition = {
    kind: KIND,
    triggerTaskId: options.taskId,
    payload: (job) => ({ subjectId: job.subjectId }),
    tracker: () => tracker,
  };
  const registry = new ExecutionRegistry(new Map([[KIND, definition]]), db);
  const counting = countingTrigger(options.trigger);
  let inProcess = 0;
  const gates = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
  registry.registerLocalHandler(KIND, (job, context) => {
    inProcess += 1;
    const run = tracker.runs.get(job.subjectId);
    if (run) run.status = "running";
    return new Promise<void>((resolve, reject) => {
      gates.set(job.subjectId, { resolve, reject });
      context.signal.addEventListener("abort", () => reject(context.signal.reason));
    });
  });
  const local =
    mode === "local" ? new LocalExecutor({ registry, timers: clock, log: silentLog }) : undefined;
  const trigger = mode === "durable" ? new TriggerExecutor(counting.client) : undefined;
  const executor: Executor = (local ?? trigger) as Executor;
  const repository = new DispatchIntentRepository(db);
  const state = new ExecutorStateService(new ExecutorStateRepository(db), mode, clock, silentLog);
  const dispatcher = new ExecutionDispatcher({
    repository,
    state,
    registry,
    executor,
    timers: clock,
    log: silentLog,
    claimLeaseMs: CLAIM_LEASE_MS,
  });
  const reconciler = new ExecutionReconciler({
    state,
    repository,
    registry,
    dispatcher,
    ...(local ? { local } : {}),
    ...(trigger ? { trigger } : {}),
    timers: clock,
    log: silentLog,
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const triggerRunIdOf = async (subjectId: string) =>
    tracker.runs.get(subjectId)?.triggerRunId ??
    (await repository.findBySubject(KIND, subjectId))?.triggerRunId ??
    null;

  const addIntent = async (subjectId: string) =>
    db.run(
      insertDispatchIntentStatement({
        id: uuidv7(clock.now()),
        ownerId: OWNER,
        kind: KIND,
        subjectId,
        now: clock.now(),
        writeId: newWriteId(),
      }),
    );

  return {
    mode,
    async record() {
      const subjectId = uuidv7(clock.now());
      // A queued subject names no executor until its intent is dispatched (§8.1).
      tracker.add(subjectId, {
        ownerId: OWNER,
        executor: null,
        status: "queued",
        createdAt: clock.now(),
      });
      await addIntent(subjectId);
      return subjectId;
    },
    async recordReachedTrigger(triggerRunId) {
      const subjectId = uuidv7(clock.now());
      tracker.add(subjectId, {
        ownerId: OWNER,
        executor: "trigger",
        status: "running",
        triggerRunId,
        createdAt: clock.now(),
      });
      await addIntent(subjectId);
      await db.run(
        sql(
          "UPDATE dispatch_intents SET executor = 'trigger', trigger_run_id = :run, write_id = :w WHERE subject_id = :subject",
          { run: triggerRunId, subject: subjectId, w: newWriteId() },
        ),
      );
      return subjectId;
    },
    async dispatch() {
      return (await dispatcher.dispatchPending()).dispatched;
    },
    async loseDispatchOutcome(subjectId) {
      await db.run(
        sql(
          `UPDATE dispatch_intents
           SET status = 'pending', trigger_run_id = NULL, dispatched_at = NULL, updated_at = :stale, write_id = :w
           WHERE subject_id = :subject`,
          { stale: int(clock.now() - CLAIM_LEASE_MS - 1), subject: subjectId, w: newWriteId() },
        ),
      );
    },
    async reconcile() {
      await reconciler.reconcileOnce();
    },
    async settle() {
      await clock.advance(0);
      await flush();
      if (fake) {
        for (const run of fake.allRuns()) {
          if (run.status === "QUEUED") fake.startRun(run.id);
        }
      }
      await flush();
    },
    async stop(subjectId) {
      const run = tracker.runs.get(subjectId);
      if (run) run.cancelRequestedAt = clock.now();
      await dispatcher.cancel(KIND, subjectId);
    },
    async crash(subjectId) {
      if (local) {
        gates.get(subjectId)?.reject(new Error("handler crashed"));
        return;
      }
      const runId = await triggerRunIdOf(subjectId);
      if (fake && runId) fake.failRun(runId, "CRASHED");
    },
    async switchExecutor() {
      await new ExecutorSwitch({
        db,
        registry,
        trigger: counting.client,
        now: () => clock.now(),
        log: silentLog,
      }).switchTo(mode === "local" ? "durable" : "local");
    },
    async subject(subjectId) {
      const run = tracker.runs.get(subjectId);
      return run ? { status: run.status, outcomeCode: run.outcomeCode } : null;
    },
    async observe(subjectId): Promise<ExecutorContractObservation> {
      const observation = await executor.observe({
        kind: KIND,
        subjectId,
        triggerRunId: await triggerRunIdOf(subjectId),
      });
      return observation.state;
    },
    counts() {
      return {
        inProcess,
        triggerRequests: counting.requests.length,
        triggerRuns: new Set(counting.requests).size,
        cancelled: [...counting.cancelled],
      };
    },
    async close() {
      await dispatcher.close();
      await reconciler.stop();
      await local?.shutdown(0);
      for (const gate of gates.values()) gate.resolve();
      if (!fake) {
        // Live runs this suite created are cancelled, best effort.
        for (const runId of new Set(counting.requests)) {
          await options.trigger.runs.cancel(runId).catch(() => undefined);
        }
      }
      db.close();
    },
  };
}

describeExecutorContract({
  name: "local executor",
  mode: "local",
  controlledJobs: true,
  create: () => {
    const clock = new FakeClock();
    const fake = new FakeTriggerClient({ clock });
    return createHarness({ mode: "local", trigger: fake, taskId: "contract-job", clock });
  },
});

describeExecutorContract({
  name: "Trigger executor over FakeTriggerClient",
  mode: "durable",
  controlledJobs: true,
  create: () => {
    const clock = new FakeClock();
    const fake = new FakeTriggerClient({ clock });
    return createHarness({ mode: "durable", trigger: fake, fake, taskId: "contract-job", clock });
  },
});

const live = liveTriggerSettings();
describeExecutorContract({
  name: "Trigger executor over live Trigger.dev",
  mode: "durable",
  controlledJobs: false,
  testTimeoutMs: 30_000,
  ...("skipReason" in live ? { skipReason: live.skipReason } : {}),
  create: () => {
    if (!("settings" in live)) throw new Error(live.skipReason);
    return createHarness({
      mode: "durable",
      trigger: createTriggerRunsClient(live.settings.secretKey),
      taskId: live.settings.taskId,
      clock: new FakeClock(Date.now()),
    });
  },
});
