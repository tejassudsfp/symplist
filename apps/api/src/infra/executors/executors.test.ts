import { Test } from "@nestjs/testing";
import type {
  EventsContributor,
  ExecutionKindDefinition,
  LocalExecutionHandler,
} from "@symplist/core/events";
import {
  applyMigrations,
  createLocalSqliteClient,
  type DbClient,
  int,
  type LocalSqliteClient,
  newWriteId,
  sql,
  uuidv7,
} from "@symplist/db";
import { FakeClock, FakeTriggerApiError, FakeTriggerClient } from "@symplist/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTracker } from "../../../test/executors/memory-tracker.ts";
import type { OperationalLog, OperationalLogFields } from "../scheduler/runtime.ts";
import { DispatchIntentRepository, insertDispatchIntentStatement } from "./dispatch-intents.ts";
import { ExecutionDispatcher } from "./dispatcher.ts";
import { ExecutionRegistry } from "./execution-registry.ts";
import { ExecutorError, observeTriggerStatus } from "./executor.ts";
import { ExecutorStateRepository, ExecutorStateService } from "./executor-state.ts";
import { ExecutorSwitch } from "./executor-switch.ts";
import { parseExecutorSwitchArgs, runExecutorSwitchCli } from "./executor-switch-cli.ts";
import { ExecutorsModule, LOCAL_EXECUTOR, TRIGGER_EXECUTOR } from "./executors.module.ts";
import { LocalExecutionAborted, LocalExecutor } from "./local-executor.ts";
import { ExecutionReconciler } from "./reconciler.ts";
import { RestrictedRunCanceller } from "./restricted-run-canceller.ts";
import { assertIdsOnlyPayload, TriggerExecutor } from "./trigger-executor.ts";

/* ------------------------------------------------------------------------------------------------
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

class RecordingLog implements OperationalLog {
  readonly entries: { level: string; event: string; fields: OperationalLogFields | undefined }[] =
    [];
  info(event: string, fields?: OperationalLogFields) {
    this.entries.push({ level: "info", event, fields });
  }
  warn(event: string, fields?: OperationalLogFields) {
    this.entries.push({ level: "warn", event, fields });
  }
  error(event: string, fields?: OperationalLogFields) {
    this.entries.push({ level: "error", event, fields });
  }
  events(): string[] {
    return this.entries.map((entry) => entry.event);
  }
}

const OWNER = "01996d2a-4c00-7000-8000-00000000a001";
const OTHER_OWNER = "01996d2a-4c00-7000-8000-00000000b002";

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a value");
  return value;
}

function definition(
  tracker: FakeTracker | undefined,
  overrides: Partial<ExecutionKindDefinition> = {},
): ExecutionKindDefinition {
  return {
    kind: "simon_run",
    triggerTaskId: "simon-run",
    payload: (job) => ({ runId: job.subjectId }),
    ...(tracker ? { tracker: () => tracker } : {}),
    ...overrides,
  };
}

function contributors(...definitions: ExecutionKindDefinition[]): EventsContributor[] {
  return [{ domain: "simon", executionKinds: definitions }];
}

async function migratedDb(): Promise<LocalSqliteClient> {
  const db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  return db;
}

async function setMode(
  db: DbClient,
  mode: "local" | "durable" | null,
  generation = 1,
): Promise<void> {
  await db.run(
    sql(
      "UPDATE executor_state SET mode = :mode, generation = :generation, write_id = :w WHERE id = 1",
      {
        mode,
        generation: int(generation),
        w: newWriteId(),
      },
    ),
  );
}

async function addIntent(
  db: DbClient,
  input: { subjectId?: string; ownerId?: string; kind?: string; now?: number } = {},
): Promise<{ id: string; subjectId: string }> {
  const id = uuidv7();
  const subjectId = input.subjectId ?? uuidv7();
  await db.run(
    insertDispatchIntentStatement({
      id,
      ownerId: input.ownerId ?? OWNER,
      kind: input.kind ?? "simon_run",
      subjectId,
      now: input.now ?? 1_000,
      writeId: newWriteId(),
    }),
  );
  return { id, subjectId };
}

async function intentRow(db: DbClient, id: string) {
  return db.first(sql("SELECT * FROM dispatch_intents WHERE id = :id", { id }));
}

interface Harness {
  db: LocalSqliteClient;
  clock: FakeClock;
  log: RecordingLog;
  tracker: FakeTracker;
  trigger: FakeTriggerClient;
  registry: ExecutionRegistry;
  state: ExecutorStateService;
  repository: DispatchIntentRepository;
}

async function harness(mode: "local" | "durable"): Promise<Harness> {
  const db = await migratedDb();
  await setMode(db, mode);
  const clock = new FakeClock(1_789_462_800_000);
  const log = new RecordingLog();
  const tracker = new FakeTracker();
  const registry = new ExecutionRegistry(new Map([["simon_run", definition(tracker)]]), db);
  return {
    db,
    clock,
    log,
    tracker,
    trigger: new FakeTriggerClient({ clock }),
    registry,
    state: new ExecutorStateService(new ExecutorStateRepository(db), mode, clock, log),
    repository: new DispatchIntentRepository(db),
  };
}

let open: LocalSqliteClient[] = [];
afterEach(() => {
  for (const db of open) db.close();
  open = [];
});
async function track(h: Promise<Harness>): Promise<Harness> {
  const value = await h;
  open.push(value.db);
  return value;
}

/* ------------------------------------------------------------------------------------------------
 * Repositories
 * --------------------------------------------------------------------------------------------- */

describe("dispatch intent repository (§8.1)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await track(harness("local"));
  });

  it("records intents at the current generation, once per kind and subject", async () => {
    await setMode(h.db, "local", 4);
    const { id, subjectId } = await addIntent(h.db);
    await addIntent(h.db, { subjectId });
    const rows = await h.db.all(
      sql("SELECT id, executor_generation, status, executor FROM dispatch_intents"),
    );
    expect(rows).toEqual([{ id, executor_generation: 4, status: "pending", executor: null }]);
  });

  it("claims an intent exactly once within the lease and again after it expires", async () => {
    const { id } = await addIntent(h.db);
    const [intent] = await h.repository.listDispatchable({
      generation: 1,
      now: 2_000,
      claimLeaseMs: 60_000,
      limit: 10,
    });
    expect(intent?.id).toBe(id);
    const first = await h.repository.claim(must(intent), {
      executor: "local",
      generation: 1,
      now: 2_000,
      claimLeaseMs: 60_000,
    });
    expect(first?.intent.attempts).toBe(1);
    expect(
      await h.repository.claim(must(intent), {
        executor: "local",
        generation: 1,
        now: 3_000,
        claimLeaseMs: 60_000,
      }),
    ).toBeNull();
    expect(
      await h.repository.listDispatchable({
        generation: 1,
        now: 3_000,
        claimLeaseMs: 60_000,
        limit: 10,
      }),
    ).toEqual([]);
    const second = await h.repository.claim(must(intent), {
      executor: "local",
      generation: 1,
      now: 62_000,
      claimLeaseMs: 60_000,
    });
    expect(second?.intent.attempts).toBe(2);
    // The first claim lost its write id, so it can no longer mark the intent dispatched.
    expect(
      await h.repository.markDispatched(must(first), { triggerRunId: null, now: 62_001 }),
    ).toBe(false);
    expect(
      await h.repository.markDispatched(must(second), { triggerRunId: null, now: 62_001 }),
    ).toBe(true);
    expect(await intentRow(h.db, id)).toMatchObject({
      status: "dispatched",
      executor: "local",
      dispatched_at: 62_001,
    });
  });

  it("never claims intents of another generation or intents that reached Trigger", async () => {
    const { id } = await addIntent(h.db);
    const [intent] = await h.repository.listDispatchable({
      generation: 1,
      now: 2_000,
      claimLeaseMs: 1,
      limit: 10,
    });
    expect(
      await h.repository.claim(must(intent), {
        executor: "trigger",
        generation: 2,
        now: 2_000,
        claimLeaseMs: 1,
      }),
    ).toBeNull();
    const claim = await h.repository.claim(must(intent), {
      executor: "trigger",
      generation: 1,
      now: 2_000,
      claimLeaseMs: 1,
    });
    await expect(
      h.repository.markDispatched(must(claim), { triggerRunId: null, now: 2_001 }),
    ).rejects.toThrow(/Trigger run id/);
    await h.db.run(
      sql("UPDATE dispatch_intents SET trigger_run_id = 'run_x' WHERE id = :id", { id }),
    );
    expect(
      await h.repository.listDispatchable({
        generation: 1,
        now: 99_999,
        claimLeaseMs: 1,
        limit: 10,
      }),
    ).toEqual([]);
    expect(
      await h.repository.claim(must(intent), {
        executor: "trigger",
        generation: 1,
        now: 99_999,
        claimLeaseMs: 1,
      }),
    ).toBeNull();
  });

  it("rebinds pending intents of older generations and clears their claims", async () => {
    const old = await addIntent(h.db);
    const [intent] = await h.repository.listDispatchable({
      generation: 1,
      now: 2_000,
      claimLeaseMs: 60_000,
      limit: 10,
    });
    await h.repository.claim(must(intent), {
      executor: "local",
      generation: 1,
      now: 2_000,
      claimLeaseMs: 60_000,
    });
    await setMode(h.db, "durable", 2);
    const fresh = await addIntent(h.db);
    expect(await h.repository.rebindPending({ generation: 2, now: 3_000 })).toBe(1);
    expect(await intentRow(h.db, old.id)).toMatchObject({ executor_generation: 2, executor: null });
    expect(await intentRow(h.db, fresh.id)).toMatchObject({ executor_generation: 2 });
    expect(await h.repository.rebindPending({ generation: 2, now: 3_000 })).toBe(0);
  });
});

describe("executor state (§8.1)", () => {
  it("records the configured mode on first start and caches reads for at most the TTL", async () => {
    const h = await track(harness("local"));
    await setMode(h.db, null);
    const readiness = await h.state.initialize();
    expect(readiness).toEqual({ usable: true, generation: 1, mode: "local" });
    expect(await new ExecutorStateRepository(h.db).read()).toMatchObject({
      mode: "local",
      generation: 1,
    });

    await setMode(h.db, "local", 7);
    expect((await h.state.readCached()).generation).toBe(1);
    await h.clock.advance(10_000);
    expect((await h.state.readCached()).generation).toBe(7);
  });

  it("reports a mode mismatch instead of executing, until the operator switches", async () => {
    const h = await track(harness("local"));
    await setMode(h.db, "durable", 3);
    expect(await h.state.initialize()).toEqual({
      usable: false,
      reason: "mode_mismatch",
      generation: 3,
    });
    expect(h.log.events()).toContain("executor.mode_mismatch");
  });

  it("advances the generation only from the generation the caller read", async () => {
    const h = await track(harness("local"));
    const repository = new ExecutorStateRepository(h.db);
    expect(
      await repository.advance({ expectedGeneration: 1, mode: "durable", now: 5 }),
    ).toMatchObject({
      mode: "durable",
      generation: 2,
      switchedAt: 5,
    });
    expect(await repository.advance({ expectedGeneration: 1, mode: "local", now: 6 })).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------------
 * Dispatch
 * --------------------------------------------------------------------------------------------- */

describe("dispatch in local mode", () => {
  it("runs the registered handler in process and never calls Trigger", async () => {
    const h = await track(harness("local"));
    const handler = vi.fn<LocalExecutionHandler>(async () => undefined);
    h.registry.registerLocalHandler("simon_run", handler);
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: local,
      timers: h.clock,
      log: h.log,
    });
    const { id, subjectId } = await addIntent(h.db);
    h.tracker.add(subjectId, { ownerId: OWNER, executor: "local", status: "queued" });

    const report = await dispatcher.dispatchPending();
    await h.clock.advance(0);

    expect(report).toEqual({ considered: 1, dispatched: 1, failed: 0, skipped: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({
      intentId: id,
      kind: "simon_run",
      subjectId,
      ownerId: OWNER,
      generation: 1,
    });
    expect(h.trigger.triggers).toEqual([]);
    expect(await intentRow(h.db, id)).toMatchObject({
      status: "dispatched",
      executor: "local",
      trigger_run_id: null,
    });
    expect(h.tracker.dispatches).toEqual([{ subjectId, executor: "local", triggerRunId: null }]);
    // A second pass finds nothing to do.
    expect((await dispatcher.dispatchPending()).considered).toBe(0);
  });

  function localDispatch(h: Harness) {
    const handler = vi.fn<LocalExecutionHandler>(async () => undefined);
    h.registry.registerLocalHandler("simon_run", handler);
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: local,
      timers: h.clock,
      log: h.log,
      claimLeaseMs: 60_000,
    });
    return { handler, local, dispatcher };
  }

  it("never starts a finished local job again after marking its intent dispatched failed", async () => {
    const h = await track(harness("local"));
    const { handler, dispatcher } = localDispatch(h);
    const { id, subjectId } = await addIntent(h.db);
    h.tracker.add(subjectId, { ownerId: OWNER, executor: null, status: "queued" });
    const markDispatched = vi
      .spyOn(h.repository, "markDispatched")
      .mockRejectedValueOnce(Object.assign(new Error("lost"), { code: "db.unknown_outcome" }));

    expect((await dispatcher.dispatchPending()).failed).toBe(1);
    await h.clock.advance(0);
    expect(handler).toHaveBeenCalledTimes(1);
    // The job finished; its intent is still pending behind the claim.
    expect(await intentRow(h.db, id)).toMatchObject({ status: "pending", executor: "local" });

    await h.clock.advance(60_000);
    expect(await dispatcher.dispatchPending()).toMatchObject({ dispatched: 1, failed: 0 });
    await h.clock.advance(0);
    markDispatched.mockRestore();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await intentRow(h.db, id)).toMatchObject({ status: "dispatched", executor: "local" });
    expect(h.log.events()).toContain("executor.dispatch_deduplicated");
    expect((await dispatcher.dispatchPending()).considered).toBe(0);
  });

  it("never starts a local job again when its claim was lost after it started", async () => {
    const h = await track(harness("local"));
    const { handler, dispatcher } = localDispatch(h);
    const { subjectId } = await addIntent(h.db);
    h.tracker.add(subjectId, { ownerId: OWNER, executor: null, status: "queued" });
    vi.spyOn(h.repository, "markDispatched").mockResolvedValueOnce(false);

    expect((await dispatcher.dispatchPending()).skipped).toBe(1);
    await h.clock.advance(60_000);
    await dispatcher.dispatchPending();
    await h.clock.advance(60_000);
    await dispatcher.dispatchPending();
    await h.clock.advance(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("records the local executor on the subject before starting, so a start lost with its api is interrupted", async () => {
    const h = await track(harness("local"));
    const { handler, local, dispatcher } = localDispatch(h);
    const { id, subjectId } = await addIntent(h.db);
    h.tracker.add(subjectId, {
      ownerId: OWNER,
      executor: null,
      status: "queued",
      createdAt: h.clock.now(),
    });
    // An api that wrote the start marker and died before running the job.
    await h.db.run(
      sql(
        `UPDATE dispatch_intents
         SET executor = 'local', local_started_at = :now, updated_at = :stale, write_id = :w
         WHERE id = :id`,
        { now: int(h.clock.now()), stale: int(h.clock.now() - 60_000), w: newWriteId(), id },
      ),
    );
    expect((await dispatcher.dispatchPending()).dispatched).toBe(1);
    await h.clock.advance(0);
    expect(handler).not.toHaveBeenCalled();
    expect(h.tracker.runs.get(subjectId)).toMatchObject({ executor: "local", status: "queued" });

    const reconciler = new ExecutionReconciler({
      state: h.state,
      repository: h.repository,
      registry: h.registry,
      dispatcher,
      local,
      timers: h.clock,
      log: h.log,
    });
    await h.clock.advance(60_000);
    await reconciler.reconcileOnce();
    expect(h.tracker.runs.get(subjectId)).toMatchObject({
      status: "interrupted",
      outcomeCode: "executor_lost",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("forgets the start marker when the local start fails before running, so a later pass starts it", async () => {
    const h = await track(harness("local"));
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: local,
      timers: h.clock,
      log: h.log,
      claimLeaseMs: 60_000,
    });
    const { id, subjectId } = await addIntent(h.db);
    h.tracker.add(subjectId, { ownerId: OWNER, executor: null, status: "queued" });
    // No handler registered yet: the start throws before any job code runs.
    expect((await dispatcher.dispatchPending()).failed).toBe(1);
    expect(await intentRow(h.db, id)).toMatchObject({ status: "pending", local_started_at: null });

    const handler = vi.fn<LocalExecutionHandler>(async () => undefined);
    h.registry.registerLocalHandler("simon_run", handler);
    await h.clock.advance(60_000);
    expect((await dispatcher.dispatchPending()).dispatched).toBe(1);
    await h.clock.advance(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses to pair a local configuration with the Trigger executor", async () => {
    const h = await track(harness("local"));
    expect(
      () =>
        new ExecutionDispatcher({
          repository: h.repository,
          state: h.state,
          registry: h.registry,
          executor: new TriggerExecutor(h.trigger),
          timers: h.clock,
          log: h.log,
        }),
    ).toThrow(/local mode dispatches only to the local executor/);
  });

  it("dispatches nothing while executor_state records another mode", async () => {
    const h = await track(harness("local"));
    await setMode(h.db, "durable", 2);
    h.registry.registerLocalHandler("simon_run", async () => undefined);
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log }),
      timers: h.clock,
      log: h.log,
    });
    await addIntent(h.db);
    expect(await dispatcher.dispatchPending()).toEqual({
      considered: 0,
      dispatched: 0,
      failed: 0,
      skipped: 0,
    });
  });
});

describe("dispatch in durable mode", () => {
  async function durable() {
    const h = await track(harness("durable"));
    const handler = vi.fn<LocalExecutionHandler>(async () => undefined);
    h.registry.registerLocalHandler("simon_run", handler);
    h.trigger.registerTask("simon-run", async () => ({ ok: true }), { maxAttempts: 1 });
    const executor = new TriggerExecutor(h.trigger);
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor,
      timers: h.clock,
      log: h.log,
      claimLeaseMs: 60_000,
    });
    return { ...h, handler, executor, dispatcher };
  }

  it("triggers the task with an ids-only payload and idempotencyKey = runId, and never runs handlers in process", async () => {
    const h = await durable();
    const { id, subjectId } = await addIntent(h.db);
    const report = await h.dispatcher.dispatchPending();
    expect(report.dispatched).toBe(1);
    expect(h.trigger.triggers).toHaveLength(1);
    expect(h.trigger.triggers[0]).toMatchObject({
      taskIdentifier: "simon-run",
      payload: { runId: subjectId },
      options: { idempotencyKey: subjectId },
      deduplicated: false,
    });
    const runId = h.trigger.triggers[0]?.runId;
    expect(await intentRow(h.db, id)).toMatchObject({
      status: "dispatched",
      executor: "trigger",
      trigger_run_id: runId,
    });
    await h.trigger.runUntilIdle();
    expect(h.handler).not.toHaveBeenCalled();
  });

  it("re-dispatches an intent whose dispatch outcome was lost onto the same Trigger run", async () => {
    const h = await durable();
    const { id, subjectId } = await addIntent(h.db);
    const markDispatched = vi
      .spyOn(h.repository, "markDispatched")
      .mockRejectedValueOnce(Object.assign(new Error("lost"), { code: "db.unknown_outcome" }));
    expect((await h.dispatcher.dispatchPending()).failed).toBe(1);
    expect(await intentRow(h.db, id)).toMatchObject({ status: "pending", trigger_run_id: null });

    await h.clock.advance(59_000);
    expect((await h.dispatcher.dispatchPending()).considered).toBe(0);
    await h.clock.advance(1_000);
    expect((await h.dispatcher.dispatchPending()).dispatched).toBe(1);
    markDispatched.mockRestore();

    const runs = new Set(h.trigger.triggers.map((record) => record.runId));
    expect(runs.size).toBe(1);
    expect(h.trigger.triggers[1]?.deduplicated).toBe(true);
    expect(await intentRow(h.db, id)).toMatchObject({ trigger_run_id: [...runs][0] });
    expect(h.tracker.dispatches.map((entry) => entry.subjectId)).toEqual([subjectId]);
  });

  it("never triggers again for an intent that already has a Trigger run id", async () => {
    const h = await durable();
    const started = await h.executor.start(
      { intentId: "i", kind: "simon_run", subjectId: uuidv7(), ownerId: OWNER, generation: 1 },
      definition(undefined),
      "run_existing",
    );
    expect(started).toEqual({ executor: "trigger", triggerRunId: "run_existing" });
    expect(h.trigger.triggers).toEqual([]);
  });

  it("maps Trigger failures to stable codes and leaves the intent for the lease to expire", async () => {
    const h = await durable();
    const { id } = await addIntent(h.db);
    vi.spyOn(h.trigger.tasks, "trigger").mockRejectedValueOnce(
      new FakeTriggerApiError(500, "boom with details"),
    );
    const report = await h.dispatcher.dispatchPending();
    expect(report.failed).toBe(1);
    const failure = h.log.entries.find((entry) => entry.event === "executor.dispatch_failed");
    expect(failure?.fields).toMatchObject({ code: "executor.trigger_unavailable" });
    expect(JSON.stringify(h.log.entries)).not.toContain("boom with details");
    expect(await intentRow(h.db, id)).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("refuses payloads that carry anything but ids", () => {
    expect(() =>
      assertIdsOnlyPayload({ runId: "01996d2a-4c00-7000-8000-000000000001" }),
    ).not.toThrow();
    expect(() => assertIdsOnlyPayload({ prompt: "Summarize my inbox please" })).toThrow(
      ExecutorError,
    );
    expect(() => assertIdsOnlyPayload({})).toThrow(ExecutorError);
  });
});

describe("Trigger status mapping (§8.1)", () => {
  it.each([
    ["COMPLETED", "completed"],
    ["CANCELED", "cancelled"],
    ["FAILED", "failed"],
    ["CRASHED", "failed"],
    ["SYSTEM_FAILURE", "failed"],
    ["EXPIRED", "failed"],
    ["TIMED_OUT", "failed"],
    ["QUEUED", "active"],
    ["EXECUTING", "active"],
    ["WAITING", "active"],
    ["PENDING_VERSION", "active"],
    ["DELAYED", "active"],
    ["DEQUEUED", "active"],
    ["SOMETHING_NEW", "active"],
  ])("maps %s to %s", (status, state) => {
    expect(observeTriggerStatus(status).state).toBe(state);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Local executor
 * --------------------------------------------------------------------------------------------- */

describe("local executor", () => {
  it("gives every job its own AbortController and turns a stop into stopped", async () => {
    const h = await track(harness("local"));
    const signals: AbortSignal[] = [];
    h.registry.registerLocalHandler("simon_run", (_job, context) => {
      signals.push(context.signal);
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason));
      });
    });
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const a = uuidv7();
    const b = uuidv7();
    h.tracker.add(a, { ownerId: OWNER, executor: "local" });
    h.tracker.add(b, { ownerId: OWNER, executor: "local" });
    const job = (subjectId: string) => ({
      intentId: subjectId,
      kind: "simon_run",
      subjectId,
      ownerId: OWNER,
      generation: 1,
    });
    await local.start(job(a), definition(h.tracker));
    await local.start(job(b), definition(h.tracker));
    await local.start(job(a), definition(h.tracker));
    await h.clock.advance(0);
    expect(signals).toHaveLength(2);
    expect(local.runningCount()).toBe(2);

    await local.cancel({ kind: "simon_run", subjectId: a, triggerRunId: null });
    await h.clock.advance(0);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toBeInstanceOf(LocalExecutionAborted);
    expect(signals[1]?.aborted).toBe(false);
    expect(h.tracker.runs.get(a)?.status).toBe("stopped");
    expect(h.tracker.runs.get(b)?.status).toBe("running");
    expect(local.isRunning("simon_run", a)).toBe(false);
  });

  it("writes heartbeats for running jobs and marks a crashed handler interrupted", async () => {
    const h = await track(harness("local"));
    let fail: (error: Error) => void = () => undefined;
    h.registry.registerLocalHandler(
      "simon_run",
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const local = new LocalExecutor({
      registry: h.registry,
      timers: h.clock,
      log: h.log,
      heartbeatIntervalMs: 20_000,
    });
    const subjectId = uuidv7();
    h.tracker.add(subjectId, { ownerId: OWNER, executor: "local" });
    await local.start(
      { intentId: "i", kind: "simon_run", subjectId, ownerId: OWNER, generation: 1 },
      definition(h.tracker),
    );
    await h.clock.advance(40_000);
    expect(h.tracker.heartbeats.map((beat) => beat.ids)).toEqual([[subjectId], [subjectId]]);

    fail(new Error("model exploded with secret text"));
    await h.clock.advance(0);
    expect(h.tracker.runs.get(subjectId)).toMatchObject({
      status: "interrupted",
      outcomeCode: "executor_error",
    });
    expect(JSON.stringify(h.log.entries)).not.toContain("secret text");
  });

  it("aborts jobs on shutdown, marks them interrupted and refuses new work", async () => {
    const h = await track(harness("local"));
    h.registry.registerLocalHandler(
      "simon_run",
      (_job, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason));
        }),
    );
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const subjectId = uuidv7();
    h.tracker.add(subjectId, { ownerId: OWNER, executor: "local" });
    await local.start(
      { intentId: "i", kind: "simon_run", subjectId, ownerId: OWNER, generation: 1 },
      definition(h.tracker),
    );
    await h.clock.advance(0);
    await local.shutdown();
    expect(h.tracker.runs.get(subjectId)).toMatchObject({
      status: "interrupted",
      outcomeCode: "executor_lost",
    });
    await expect(
      local.start(
        { intentId: "j", kind: "simon_run", subjectId: uuidv7(), ownerId: OWNER, generation: 1 },
        definition(h.tracker),
      ),
    ).rejects.toThrow(ExecutorError);
  });

  it("never runs an intent that reached Trigger and fails without a registered handler", async () => {
    const h = await track(harness("local"));
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const job = {
      intentId: "i",
      kind: "simon_run",
      subjectId: uuidv7(),
      ownerId: OWNER,
      generation: 1,
    };
    await expect(local.start(job, definition(h.tracker))).rejects.toMatchObject({
      code: "executor.handler_missing",
    });
    h.registry.registerLocalHandler("simon_run", async () => undefined);
    await expect(local.start(job, definition(h.tracker), "run_1")).rejects.toThrow(ExecutorError);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Reconciler
 * --------------------------------------------------------------------------------------------- */

describe("reconciler", () => {
  it("interrupts local runs without a heartbeat for 60 seconds, but not fresh or in-process ones", async () => {
    const h = await track(harness("local"));
    let release: () => void = () => undefined;
    h.registry.registerLocalHandler(
      "simon_run",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: local,
      timers: h.clock,
      log: h.log,
    });
    const reconciler = new ExecutionReconciler({
      state: h.state,
      repository: h.repository,
      registry: h.registry,
      dispatcher,
      local,
      timers: h.clock,
      log: h.log,
    });
    const now = h.clock.now();
    const stale = "01996d2a-4c00-7000-8000-000000000001";
    const fresh = "01996d2a-4c00-7000-8000-000000000002";
    const inProcess = "01996d2a-4c00-7000-8000-000000000003";
    const durableRun = "01996d2a-4c00-7000-8000-000000000004";
    h.tracker.add(stale, { ownerId: OWNER, executor: "local", heartbeatAt: now - 60_000 });
    h.tracker.add(fresh, { ownerId: OWNER, executor: "local", heartbeatAt: now - 59_000 });
    h.tracker.add(inProcess, { ownerId: OWNER, executor: "local", heartbeatAt: now - 600_000 });
    h.tracker.add(durableRun, {
      ownerId: OWNER,
      executor: "trigger",
      triggerRunId: "run_x",
      heartbeatAt: null,
      createdAt: 0,
    });
    await local.start(
      { intentId: "i", kind: "simon_run", subjectId: inProcess, ownerId: OWNER, generation: 1 },
      definition(h.tracker),
    );

    const report = await reconciler.reconcileOnce();
    expect(report).toMatchObject({ ran: true, interrupted: 1 });
    expect(h.tracker.runs.get(stale)).toMatchObject({
      status: "interrupted",
      outcomeCode: "executor_lost",
    });
    expect(h.tracker.runs.get(fresh)?.status).toBe("running");
    expect(h.tracker.runs.get(inProcess)?.status).toBe("running");
    expect(h.tracker.runs.get(durableRun)?.status).toBe("running");
    expect(h.trigger.triggers).toEqual([]);
    release();
  });

  it("polls Trigger in durable mode: failures interrupt, stops become stopped, active runs stay", async () => {
    const h = await track(harness("durable"));
    const trigger = new TriggerExecutor(h.trigger);
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: trigger,
      timers: h.clock,
      log: h.log,
    });
    const reconciler = new ExecutionReconciler({
      state: h.state,
      repository: h.repository,
      registry: h.registry,
      dispatcher,
      trigger,
      timers: h.clock,
      log: h.log,
    });
    const handles = await Promise.all(
      ["crashed", "cancelled", "executing", "completed", "failed_stop", "local"].map((name) =>
        h.trigger.tasks.trigger("simon-run", { runId: name }, { idempotencyKey: name }),
      ),
    );
    const [crashed, cancelled, executing, completed, failedStop] = handles.map(
      (handle) => handle.id,
    );
    for (const id of [crashed, executing, completed, failedStop]) h.trigger.startRun(must(id));
    h.trigger.failRun(must(crashed), "CRASHED");
    await h.trigger.runs.cancel(must(cancelled));
    h.trigger.completeRun(must(completed), { ok: true });
    h.trigger.failRun(must(failedStop), "SYSTEM_FAILURE");
    const ids = {
      crashed: "01996d2a-4c00-7000-8000-000000000011",
      cancelled: "01996d2a-4c00-7000-8000-000000000012",
      executing: "01996d2a-4c00-7000-8000-000000000013",
      completed: "01996d2a-4c00-7000-8000-000000000014",
      failedStop: "01996d2a-4c00-7000-8000-000000000015",
      local: "01996d2a-4c00-7000-8000-000000000016",
    };
    h.tracker.add(ids.crashed, {
      ownerId: OWNER,
      executor: "trigger",
      triggerRunId: must(crashed),
    });
    h.tracker.add(ids.cancelled, {
      ownerId: OWNER,
      executor: "trigger",
      triggerRunId: must(cancelled),
      cancelRequestedAt: 5,
    });
    h.tracker.add(ids.executing, {
      ownerId: OWNER,
      executor: "trigger",
      triggerRunId: must(executing),
    });
    h.tracker.add(ids.completed, {
      ownerId: OWNER,
      executor: "trigger",
      triggerRunId: must(completed),
    });
    h.tracker.add(ids.failedStop, {
      ownerId: OWNER,
      executor: "trigger",
      triggerRunId: must(failedStop),
      cancelRequestedAt: 9,
    });
    h.tracker.add(ids.local, { ownerId: OWNER, executor: "local", heartbeatAt: 0 });

    const report = await reconciler.reconcileOnce();
    expect(report).toMatchObject({ interrupted: 2, stopped: 2 });
    expect(h.tracker.runs.get(ids.crashed)).toMatchObject({
      status: "interrupted",
      outcomeCode: "executor_failed",
    });
    expect(h.tracker.runs.get(ids.completed)).toMatchObject({
      status: "interrupted",
      outcomeCode: "executor_failed",
    });
    expect(h.tracker.runs.get(ids.cancelled)?.status).toBe("stopped");
    expect(h.tracker.runs.get(ids.failedStop)?.status).toBe("stopped");
    expect(h.tracker.runs.get(ids.executing)?.status).toBe("running");
    // Local runs are never touched by a durable-mode api.
    expect(h.tracker.runs.get(ids.local)?.status).toBe("running");
  });

  it("re-dispatches only intents without a Trigger run id and does nothing on a mode mismatch", async () => {
    const h = await track(harness("durable"));
    h.trigger.registerTask("simon-run", async () => undefined);
    const trigger = new TriggerExecutor(h.trigger);
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: trigger,
      timers: h.clock,
      log: h.log,
    });
    const reconciler = new ExecutionReconciler({
      state: h.state,
      repository: h.repository,
      registry: h.registry,
      dispatcher,
      trigger,
      timers: h.clock,
      log: h.log,
    });
    const reached = await addIntent(h.db);
    await h.db.run(
      sql(
        "UPDATE dispatch_intents SET status = 'dispatched', executor = 'trigger', trigger_run_id = 'run_old', dispatched_at = 1 WHERE id = :id",
        { id: reached.id },
      ),
    );
    const pending = await addIntent(h.db);
    expect((await reconciler.reconcileOnce()).dispatched).toBe(1);
    expect(h.trigger.triggers.map((record) => record.payload)).toEqual([
      { runId: pending.subjectId },
    ]);

    await setMode(h.db, "local", 2);
    await addIntent(h.db);
    expect(await reconciler.reconcileOnce()).toMatchObject({ ran: false });
    expect(h.trigger.triggers).toHaveLength(1);
  });

  it("records an unrecorded mode on its next pass when bootstrap could not", async () => {
    const h = await track(harness("local"));
    await setMode(h.db, null);
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: local,
      timers: h.clock,
      log: h.log,
    });
    const reconciler = new ExecutionReconciler({
      state: h.state,
      repository: h.repository,
      registry: h.registry,
      dispatcher,
      local,
      timers: h.clock,
      log: h.log,
    });
    expect((await reconciler.reconcileOnce()).ran).toBe(true);
    expect(await new ExecutorStateRepository(h.db).read()).toMatchObject({ mode: "local" });
  });

  it("aborts in-process jobs of a retired generation or mode after an executor switch", async () => {
    const h = await track(harness("local"));
    const aborted: string[] = [];
    h.registry.registerLocalHandler("simon_run", (job, context) => {
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          aborted.push(
            `${job.subjectId}:${(context.signal.reason as LocalExecutionAborted).reason}`,
          );
          reject(context.signal.reason);
        });
      });
    });
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: local,
      timers: h.clock,
      log: h.log,
    });
    const reconciler = new ExecutionReconciler({
      state: h.state,
      repository: h.repository,
      registry: h.registry,
      dispatcher,
      local,
      timers: h.clock,
      log: h.log,
    });
    const job = (subjectId: string, generation: number) => ({
      intentId: subjectId,
      kind: "simon_run",
      subjectId,
      ownerId: OWNER,
      generation,
    });
    await local.start(job("old", 1), definition(h.tracker));
    await local.start(job("current", 3), definition(h.tracker));
    await h.clock.advance(0);

    // local → durable → local moved the generation to 3: only the generation-1 job is stale.
    await setMode(h.db, "local", 3);
    await reconciler.reconcileOnce();
    await h.clock.advance(0);
    expect(aborted).toEqual(["old:switched"]);
    expect(local.isRunning("simon_run", "current")).toBe(true);

    // Switched to durable: nothing may keep running in process.
    await setMode(h.db, "durable", 4);
    expect((await reconciler.reconcileOnce()).ran).toBe(false);
    await h.clock.advance(0);
    expect(aborted).toEqual(["old:switched", "current:switched"]);
    expect(local.runningCount()).toBe(0);
    expect(h.log.events()).toContain("executor.local_jobs_switched");
  });

  it("polls a durable run whose Trigger run id reached only its intent, and repairs the run", async () => {
    const h = await track(harness("durable"));
    const trigger = new TriggerExecutor(h.trigger);
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: trigger,
      timers: h.clock,
      log: h.log,
    });
    const reconciler = new ExecutionReconciler({
      state: h.state,
      repository: h.repository,
      registry: h.registry,
      dispatcher,
      trigger,
      timers: h.clock,
      log: h.log,
    });
    const { id, subjectId } = await addIntent(h.db);
    const handle = await h.trigger.tasks.trigger(
      "simon-run",
      { runId: subjectId },
      { idempotencyKey: subjectId },
    );
    h.trigger.startRun(handle.id);
    h.trigger.failRun(handle.id, "CRASHED");
    await h.db.run(
      sql(
        "UPDATE dispatch_intents SET status = 'dispatched', executor = 'trigger', trigger_run_id = :run, dispatched_at = 1 WHERE id = :id",
        { run: handle.id, id },
      ),
    );
    // The dispatcher stored the run id on the intent but its recordDispatch on the run failed.
    h.tracker.add(subjectId, { ownerId: OWNER, executor: "trigger", triggerRunId: null });

    expect(await reconciler.reconcileOnce()).toMatchObject({ interrupted: 1 });
    expect(h.tracker.runs.get(subjectId)).toMatchObject({
      status: "interrupted",
      outcomeCode: "executor_failed",
      triggerRunId: handle.id,
    });
    expect(h.tracker.dispatches).toEqual([
      { subjectId, executor: "trigger", triggerRunId: handle.id },
    ]);
  });

  it("refuses executors of the wrong mode", async () => {
    const h = await track(harness("local"));
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const dispatcher = new ExecutionDispatcher({
      repository: h.repository,
      state: h.state,
      registry: h.registry,
      executor: local,
      timers: h.clock,
      log: h.log,
    });
    expect(
      () =>
        new ExecutionReconciler({
          state: h.state,
          repository: h.repository,
          registry: h.registry,
          dispatcher,
          local,
          trigger: new TriggerExecutor(h.trigger),
          timers: h.clock,
          log: h.log,
        }),
    ).toThrow(/local executor only/);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Executor switch
 * --------------------------------------------------------------------------------------------- */

describe("executor switch (§8.1)", () => {
  it.each([
    ["local", "durable"],
    ["durable", "local"],
  ] as const)(
    "%s → %s retires active work and the new executor dispatches rebound pending work",
    async (from, to) => {
      const h = await track(harness(from));
      const active = uuidv7();
      let oldTriggerRunId: string | null = null;
      if (from === "durable") {
        const handle = await h.trigger.tasks.trigger(
          "simon-run",
          { runId: active },
          { idempotencyKey: active },
        );
        h.trigger.startRun(handle.id);
        oldTriggerRunId = handle.id;
      }
      h.tracker.add(active, {
        ownerId: OWNER,
        executor: from === "durable" ? "trigger" : "local",
        triggerRunId: oldTriggerRunId,
      });
      const pending = await addIntent(h.db);
      h.tracker.add(pending.subjectId, {
        ownerId: OWNER,
        executor: null,
        status: "queued",
      });

      const report = await new ExecutorSwitch({
        db: h.db,
        registry: h.registry,
        trigger: h.trigger,
        now: () => h.clock.now(),
        log: h.log,
      }).switchTo(to);
      expect(report).toMatchObject({
        from,
        to,
        advanced: true,
        generation: 2,
        interrupted: 1,
        rebound: 1,
      });
      expect(h.tracker.runs.get(active)).toMatchObject({
        status: "interrupted",
        outcomeCode: "executor_switched",
      });
      if (oldTriggerRunId)
        expect((await h.trigger.runs.retrieve(oldTriggerRunId)).status).toBe("CANCELED");

      const localCalls = vi.fn(async () => {});
      if (to === "local") h.registry.registerLocalHandler("simon_run", localCalls);
      const local =
        to === "local"
          ? new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log })
          : null;
      const dispatcher = new ExecutionDispatcher({
        repository: h.repository,
        state: new ExecutorStateService(new ExecutorStateRepository(h.db), to, h.clock, h.log),
        registry: h.registry,
        executor: local ?? new TriggerExecutor(h.trigger),
        timers: h.clock,
        log: h.log,
      });
      try {
        expect(await dispatcher.dispatchPending()).toEqual({
          considered: 1,
          dispatched: 1,
          failed: 0,
          skipped: 0,
        });
        expect(await intentRow(h.db, pending.id)).toMatchObject({
          status: "dispatched",
          executor: to === "local" ? "local" : "trigger",
          executor_generation: 2,
        });
        expect(h.tracker.runs.get(pending.subjectId)).toMatchObject({
          executor: to === "local" ? "local" : "trigger",
          generation: 2,
        });
        expect(localCalls).toHaveBeenCalledTimes(to === "local" ? 1 : 0);
      } finally {
        await dispatcher.close();
        await local?.shutdown(0);
      }
    },
  );

  it("local → durable advances the generation, interrupts local runs and rebinds pending intents", async () => {
    const h = await track(harness("local"));
    const running = "01996d2a-4c00-7000-8000-000000000021";
    h.tracker.add(running, { ownerId: OWNER, executor: "local" });
    const pending = await addIntent(h.db);
    const report = await new ExecutorSwitch({
      db: h.db,
      registry: h.registry,
      trigger: null,
      now: () => 9_000,
      log: h.log,
    }).switchTo("durable");
    expect(report).toEqual({
      from: "local",
      to: "durable",
      advanced: true,
      generation: 2,
      interrupted: 1,
      cancelledTriggerRuns: 0,
      cancelFailures: 0,
      rebound: 1,
    });
    expect(h.tracker.runs.get(running)).toMatchObject({
      status: "interrupted",
      outcomeCode: "executor_switched",
    });
    expect(await intentRow(h.db, pending.id)).toMatchObject({ executor_generation: 2 });
    expect(await new ExecutorStateRepository(h.db).read()).toMatchObject({
      mode: "durable",
      generation: 2,
      switchedAt: 9_000,
    });
  });

  it("durable → local cancels Trigger runs itself, and a rerun completes idempotently", async () => {
    const h = await track(harness("durable"));
    const handle = await h.trigger.tasks.trigger(
      "simon-run",
      { runId: "a" },
      { idempotencyKey: "a" },
    );
    h.trigger.startRun(handle.id);
    const active = "01996d2a-4c00-7000-8000-000000000031";
    h.tracker.add(active, { ownerId: OWNER, executor: "trigger", triggerRunId: handle.id });
    const switcher = new ExecutorSwitch({
      db: h.db,
      registry: h.registry,
      trigger: h.trigger,
      now: () => 1,
      log: h.log,
      pageSize: 1,
    });
    expect(await switcher.switchTo("local")).toMatchObject({
      advanced: true,
      generation: 2,
      interrupted: 1,
      cancelledTriggerRuns: 1,
    });
    expect(h.trigger.cancellations).toEqual([handle.id]);
    expect((await h.trigger.runs.retrieve(handle.id)).status).toBe("CANCELED");
    expect(await switcher.switchTo("local")).toMatchObject({
      advanced: false,
      generation: 2,
      interrupted: 0,
      cancelledTriggerRuns: 0,
    });
  });

  it("completes a switch that stopped after advancing the generation when the command is run again", async () => {
    const h = await track(harness("durable"));
    const handles = await Promise.all(
      ["a", "b"].map((name) =>
        h.trigger.tasks.trigger("simon-run", { runId: name }, { idempotencyKey: name }),
      ),
    );
    const subjects = [
      "01996d2a-4c00-7000-8000-000000000041",
      "01996d2a-4c00-7000-8000-000000000042",
    ];
    handles.forEach((handle, index) => {
      h.trigger.startRun(handle.id);
      h.tracker.add(must(subjects[index]), {
        ownerId: OWNER,
        executor: "trigger",
        triggerRunId: handle.id,
      });
    });
    const markInterrupted = vi
      .spyOn(h.tracker, "markInterrupted")
      .mockRejectedValueOnce(
        Object.assign(new Error("D1 unavailable"), { code: "db.unavailable" }),
      );
    const switcher = new ExecutorSwitch({
      db: h.db,
      registry: h.registry,
      trigger: h.trigger,
      now: () => 1,
      log: h.log,
    });
    await expect(switcher.switchTo("local")).rejects.toMatchObject({ code: "db.unavailable" });
    expect(await new ExecutorStateRepository(h.db).read()).toMatchObject({
      mode: "local",
      generation: 2,
    });
    expect(h.tracker.runs.get(must(subjects[0]))?.status).toBe("running");

    markInterrupted.mockRestore();
    expect(await switcher.switchTo("local")).toMatchObject({
      advanced: false,
      generation: 2,
      interrupted: 2,
      cancelFailures: 0,
    });
    for (const subject of subjects) {
      expect(h.tracker.runs.get(subject)).toMatchObject({
        status: "interrupted",
        outcomeCode: "executor_switched",
      });
    }
    for (const handle of handles) {
      expect((await h.trigger.runs.retrieve(handle.id)).status).toBe("CANCELED");
    }
  });

  it("leaves a run whose Trigger cancel failed active so a rerun retries it, and treats 404 as gone", async () => {
    const h = await track(harness("durable"));
    const handle = await h.trigger.tasks.trigger(
      "simon-run",
      { runId: "a" },
      { idempotencyKey: "a" },
    );
    h.trigger.startRun(handle.id);
    const failing = "01996d2a-4c00-7000-8000-000000000051";
    const vanished = "01996d2a-4c00-7000-8000-000000000052";
    h.tracker.add(failing, { ownerId: OWNER, executor: "trigger", triggerRunId: handle.id });
    h.tracker.add(vanished, { ownerId: OWNER, executor: "trigger", triggerRunId: "run_unknown" });
    const cancel = vi
      .spyOn(h.trigger.runs, "cancel")
      .mockRejectedValueOnce(new FakeTriggerApiError(503, "unavailable"));
    const switcher = new ExecutorSwitch({
      db: h.db,
      registry: h.registry,
      trigger: h.trigger,
      now: () => 1,
      log: h.log,
    });
    expect(await switcher.switchTo("local")).toMatchObject({
      advanced: true,
      interrupted: 1,
      cancelledTriggerRuns: 0,
      cancelFailures: 1,
    });
    expect(h.tracker.runs.get(failing)?.status).toBe("running");
    expect(h.tracker.runs.get(vanished)?.status).toBe("interrupted");

    cancel.mockRestore();
    expect(await switcher.switchTo("local")).toMatchObject({
      advanced: false,
      interrupted: 1,
      cancelledTriggerRuns: 1,
      cancelFailures: 0,
    });
    expect(h.tracker.runs.get(failing)?.status).toBe("interrupted");
    expect((await h.trigger.runs.retrieve(handle.id)).status).toBe("CANCELED");
  });

  it("needs Trigger credentials in local mode only when leftover durable runs must be cancelled", async () => {
    const h = await track(harness("local"));
    const switcher = new ExecutorSwitch({
      db: h.db,
      registry: h.registry,
      trigger: null,
      now: () => 1,
      log: h.log,
    });
    expect(await switcher.switchTo("local")).toMatchObject({ advanced: false, interrupted: 0 });
    h.tracker.add("01996d2a-4c00-7000-8000-000000000061", {
      ownerId: OWNER,
      executor: "trigger",
      triggerRunId: "run_leftover",
    });
    await expect(switcher.switchTo("local")).rejects.toMatchObject({
      code: "executor.not_configured",
    });
    expect(h.tracker.runs.get("01996d2a-4c00-7000-8000-000000000061")?.status).toBe("running");
  });

  it("requires Trigger credentials to leave durable mode", async () => {
    const h = await track(harness("durable"));
    await expect(
      new ExecutorSwitch({
        db: h.db,
        registry: h.registry,
        trigger: null,
        now: () => 1,
        log: h.log,
      }).switchTo("local"),
    ).rejects.toMatchObject({ code: "executor.not_configured" });
    expect(await new ExecutorStateRepository(h.db).read()).toMatchObject({
      mode: "durable",
      generation: 1,
    });
  });

  it("fails without writing when another switch moved the generation first", async () => {
    const h = await track(harness("local"));
    const racing: DbClient = {
      batch: async (statements, options) => {
        if (statements[0]?.sql.includes("generation = generation + 1"))
          await setMode(h.db, "durable", 5);
        return h.db.batch(statements, options);
      },
      all: (statement, options) => h.db.all(statement, options),
      first: (statement, options) => h.db.first(statement, options),
      run: (statement, options) => h.db.run(statement, options),
    };
    await expect(
      new ExecutorSwitch({
        db: racing,
        registry: h.registry,
        trigger: null,
        now: () => 1,
        log: h.log,
      }).switchTo("durable"),
    ).rejects.toMatchObject({ code: "executor.switch_conflict" });
  });
});

describe("executor:switch command", () => {
  const env = (overrides: Record<string, string> = {}) => ({
    NODE_ENV: "development",
    WEB_ORIGIN: "http://localhost:3000",
    API_ORIGIN: "http://localhost:4000",
    WS_ORIGIN: "ws://localhost:4000",
    ARTIFACT_ORIGIN: "http://127.0.0.1:4000",
    DATA_DRIVER: "local",
    EMAIL_DRIVER: "log",
    DURABLE: "false",
    EMAIL_FROM_SECURITY: "security@example.com",
    EMAIL_FROM_REMINDERS: "reminders@example.com",
    ...Object.fromEntries(
      [
        "CONTENT_KEK",
        "INTERNAL_EVENT_SECRET",
        "REMINDER_UNSUBSCRIBE_SECRET",
        "VAULT_RECOVERY_KEY",
        "SESSION_DIGEST_SECRET",
        "OTP_DIGEST_SECRET",
        "INVITE_DIGEST_SECRET",
        "SHARE_DIGEST_SECRET",
        "SHARE_SESSION_DIGEST_SECRET",
        "MCP_TOKEN_DIGEST_SECRET",
        "MCP_OAUTH_SIGNING_KEY",
        "IDEMPOTENCY_SECRET",
      ].flatMap((family, index) => [
        [`${family}_1`, Buffer.alloc(32, index + 1).toString("base64url")],
        [`${family}_CURRENT`, "1"],
      ]),
    ),
    ...overrides,
  });

  it("parses --to local|durable only", () => {
    expect(parseExecutorSwitchArgs(["--to", "local"])).toBe("local");
    expect(parseExecutorSwitchArgs(["--", "--to=durable"])).toBe("durable");
    expect(parseExecutorSwitchArgs(["--to", "trigger"])).toBeNull();
    expect(parseExecutorSwitchArgs([])).toBeNull();
    expect(parseExecutorSwitchArgs(["--to", "local", "--force"])).toBeNull();
  });

  it("switches through the injected database and prints counts only", async () => {
    const h = await track(harness("local"));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runExecutorSwitchCli(["--to", "durable"], {
      env: env(),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      now: () => 42,
      createDb: () => h.db,
      registry: () => h.registry,
    });
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out.join("\n")).toContain("local -> durable; generation 2");
    expect(out.join("\n")).toContain("DURABLE=true");
  });

  it("exits 2 on bad arguments or configuration without echoing secret values", async () => {
    const err: string[] = [];
    const io = { stdout: () => undefined, stderr: (line: string) => err.push(line) };
    expect(await runExecutorSwitchCli(["--to"], { ...io, env: env() })).toBe(2);
    const badEnv = env({ SESSION_DIGEST_SECRET_1: "not-a-secret-value-xyz" });
    expect(await runExecutorSwitchCli(["--to", "local"], { ...io, env: badEnv })).toBe(2);
    expect(err.join("\n")).not.toContain("not-a-secret-value-xyz");
  });

  it("exits 1 with a stable code when leaving durable mode without Trigger credentials", async () => {
    const h = await track(harness("durable"));
    const err: string[] = [];
    const code = await runExecutorSwitchCli(["--to", "local"], {
      env: env(),
      stdout: () => undefined,
      stderr: (line) => err.push(line),
      createDb: () => h.db,
      registry: () => h.registry,
    });
    expect(code).toBe(1);
    expect(err[0]).toContain("executor.not_configured");
  });
});

/* ------------------------------------------------------------------------------------------------
 * Restriction cancellation and module wiring
 * --------------------------------------------------------------------------------------------- */

describe("restricted run canceller (§5.5)", () => {
  it("cancels the stored Trigger runs of the restricted user's stop-requested runs only", async () => {
    const h = await track(harness("durable"));
    const mine = "01996d2a-4c00-7000-8000-000000000081";
    const recovered = "01996d2a-4c00-7000-8000-000000000082";
    const notRequested = "01996d2a-4c00-7000-8000-000000000083";
    const theirs = "01996d2a-4c00-7000-8000-000000000084";
    h.tracker.add(mine, {
      ownerId: OWNER,
      executor: "trigger",
      triggerRunId: "run_mine",
      cancelRequestedAt: 5,
    });
    // The run record missed its Trigger run id; the dispatched intent still holds it.
    h.tracker.add(recovered, { ownerId: OWNER, executor: "trigger", cancelRequestedAt: 5 });
    const intent = await addIntent(h.db, { ownerId: OWNER, subjectId: recovered });
    await h.db.run(
      sql(
        "UPDATE dispatch_intents SET status = 'dispatched', executor = 'trigger', trigger_run_id = 'run_recovered', dispatched_at = 1 WHERE id = :id",
        { id: intent.id },
      ),
    );
    h.tracker.add(notRequested, {
      ownerId: OWNER,
      executor: "trigger",
      triggerRunId: "run_unrequested",
    });
    h.tracker.add(theirs, {
      ownerId: OTHER_OWNER,
      executor: "trigger",
      triggerRunId: "run_theirs",
      cancelRequestedAt: 5,
    });
    const cancel = vi.spyOn(h.trigger.runs, "cancel").mockResolvedValue({ id: "x" });
    const canceller = new RestrictedRunCanceller({
      registry: h.registry,
      repository: h.repository,
      local: null,
      trigger: new TriggerExecutor(h.trigger),
      log: h.log,
    });
    await canceller.cancelRestrictedRuns({ userId: OWNER, accessGeneration: 2 });
    expect(cancel.mock.calls.map(([runId]) => runId).sort()).toEqual(["run_mine", "run_recovered"]);
    expect(h.log.events()).toContain("executor.restriction_cancelled");
  });

  it("logs and continues when Trigger refuses a cancel, never throwing to the restriction", async () => {
    const h = await track(harness("durable"));
    for (const [subjectId, run] of [
      ["01996d2a-4c00-7000-8000-000000000091", "run_a"],
      ["01996d2a-4c00-7000-8000-000000000092", "run_b"],
    ] as const) {
      h.tracker.add(subjectId, {
        ownerId: OWNER,
        executor: "trigger",
        triggerRunId: run,
        cancelRequestedAt: 5,
      });
    }
    const cancel = vi
      .spyOn(h.trigger.runs, "cancel")
      .mockRejectedValueOnce(new FakeTriggerApiError(500, "boom"))
      .mockResolvedValue({ id: "x" });
    const canceller = new RestrictedRunCanceller({
      registry: h.registry,
      repository: h.repository,
      local: null,
      trigger: new TriggerExecutor(h.trigger),
      log: h.log,
    });
    await expect(
      canceller.cancelRestrictedRuns({ userId: OWNER, accessGeneration: 2 }),
    ).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(h.log.events()).toContain("executor.restriction_cancel_failed");
  });

  it("aborts only the restricted user's local controllers in local mode and never calls Trigger", async () => {
    const h = await track(harness("local"));
    h.registry.registerLocalHandler(
      "simon_run",
      (_job, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason));
        }),
    );
    const local = new LocalExecutor({ registry: h.registry, timers: h.clock, log: h.log });
    const mine = "01996d2a-4c00-7000-8000-000000000071";
    const theirs = "01996d2a-4c00-7000-8000-000000000072";
    h.tracker.add(mine, { ownerId: OWNER, executor: "local", cancelRequestedAt: 5 });
    h.tracker.add(theirs, { ownerId: OTHER_OWNER, executor: "local", cancelRequestedAt: 5 });
    for (const [subjectId, ownerId] of [
      [mine, OWNER],
      [theirs, OTHER_OWNER],
    ] as const) {
      await local.start(
        { intentId: subjectId, kind: "simon_run", subjectId, ownerId, generation: 1 },
        definition(h.tracker),
      );
    }
    await h.clock.advance(0);
    const trigger = vi.spyOn(h.trigger.runs, "cancel");
    const canceller = new RestrictedRunCanceller({
      registry: h.registry,
      repository: h.repository,
      local,
      trigger: null,
      log: h.log,
    });
    await canceller.cancelRestrictedRuns({ userId: OWNER, accessGeneration: 3 });
    await h.clock.advance(0);
    expect(local.isRunning("simon_run", mine)).toBe(false);
    expect(h.tracker.runs.get(mine)?.status).toBe("stopped");
    expect(local.isRunning("simon_run", theirs)).toBe(true);
    expect(h.tracker.runs.get(theirs)?.status).toBe("running");
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("ExecutorsModule", () => {
  it("builds only the local executor in local mode and records the mode at bootstrap", async () => {
    const db = await migratedDb();
    open.push(db);
    await setMode(db, null);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ExecutorsModule.forRoot({
          useFactory: () => ({
            db,
            durable: false,
            backgroundLoops: false,
            contributors: contributors(definition(new FakeTracker())),
            log: new RecordingLog(),
          }),
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(moduleRef.get(LOCAL_EXECUTOR)).toBeInstanceOf(LocalExecutor);
    expect(moduleRef.get(TRIGGER_EXECUTOR)).toBeNull();
    expect(moduleRef.get(RestrictedRunCanceller)).toBeInstanceOf(RestrictedRunCanceller);
    expect(moduleRef.get(ExecutionRegistry).kinds()).toEqual(["simon_run"]);
    expect(await new ExecutorStateRepository(db).read()).toMatchObject({ mode: "local" });
    await app.close();
  });

  it("builds only the Trigger executor in durable mode and refuses to start without a client", async () => {
    const db = await migratedDb();
    open.push(db);
    const trigger = new FakeTriggerClient();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ExecutorsModule.forRoot({
          useFactory: () => ({
            db,
            durable: true,
            trigger,
            backgroundLoops: false,
            log: new RecordingLog(),
          }),
        }),
      ],
    }).compile();
    expect(moduleRef.get(LOCAL_EXECUTOR)).toBeNull();
    expect(moduleRef.get(TRIGGER_EXECUTOR)).toBeInstanceOf(TriggerExecutor);
    await moduleRef.close();

    await expect(
      Test.createTestingModule({
        imports: [
          ExecutorsModule.forRoot({
            useFactory: () => ({
              db,
              durable: true,
              backgroundLoops: false,
              log: new RecordingLog(),
            }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/TRIGGER_SECRET_KEY/);
  });
});
