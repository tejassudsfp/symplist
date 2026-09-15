import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActiveExecution, EventsContributor, ExecutionTracker } from "@symplist/core/events";
import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  json,
  type LocalSqliteClient,
  newWriteId,
  sql,
  uuidv7,
} from "@symplist/db";
import { createLocalObjectStore, type LocalObjectStore } from "@symplist/storage";
import { FakeClock, FakeTriggerClient } from "@symplist/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAccountPurgeTask } from "./account-purge.ts";
import { createWorkerLogger, type WorkerLogSink } from "./logger.ts";

const now = 1_789_500_000_000;
let db: LocalSqliteClient;
let objects: LocalObjectStore;
let dir: string;
let clock: FakeClock;
let trigger: FakeTriggerClient;
let logged: { level: string; message: string; properties: unknown }[];

function logger() {
  const sink: WorkerLogSink = {
    info: (message, properties) => logged.push({ level: "info", message, properties }),
    warn: (message, properties) => logged.push({ level: "warn", message, properties }),
    error: (message, properties) => logged.push({ level: "error", message, properties }),
  };
  return createWorkerLogger(sink);
}

/** A deleted account as the deletion batch leaves it (§5.6): deleting, shredded, purge pending. */
async function deletedAccount(options: { generation?: number } = {}): Promise<string> {
  const userId = uuidv7(now);
  await db.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, deletion_state, deletion_requested_at, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, 'deleting', :now, :now, :now, :w)`,
      { id: userId, email: `${userId}@example.test`, now: int(now), w: newWriteId() },
    ),
    sql(
      `INSERT INTO account_deletions (user_id, analytics_id, email_digest, email_digest_version, composio_user_id,
         r2_prefix, requested_at, status, steps_done, updated_at, write_id)
       VALUES (:id, NULL, 'digest', 1, :id, :prefix, :now, 'pending', :steps, :now, :w)`,
      { id: userId, prefix: `u/${userId}/`, now: int(now), steps: json([]), w: newWriteId() },
    ),
    sql(
      `INSERT INTO auth_sessions (id, user_id, token_digest, digest_version, created_at, last_seen_at, expires_at, revoked_at, write_id)
       VALUES (:session, :id, :digest, 1, :now, :now, :exp, :now, :w)`,
      {
        session: uuidv7(now),
        id: userId,
        digest: `digest-${userId}`,
        now: int(now),
        exp: int(now + 1000),
        w: newWriteId(),
      },
    ),
    sql(
      `INSERT INTO dispatch_intents (id, owner_id, kind, subject_id, status, executor, executor_generation,
         trigger_run_id, attempts, created_at, updated_at, dispatched_at, write_id)
       VALUES (:intent, :id, 'account_purge', :id, 'dispatched', 'trigger', :generation, 'run_purge1', 1, :now, :now, :now, :w)`,
      {
        intent: uuidv7(now),
        id: userId,
        generation: int(options.generation ?? 1),
        now: int(now),
        w: newWriteId(),
      },
    ),
  ]);
  await objects.put({ key: `u/${userId}/docs/t1/c1.md.sym`, body: new Uint8Array([1, 2, 3]) });
  await objects.put({ key: `u/${userId}/search/1-w.idx`, body: new Uint8Array([4]) });
  return userId;
}

async function setMode(mode: "local" | "durable", generation = 1): Promise<void> {
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

const dependencies = (overrides: Partial<Parameters<typeof runAccountPurgeTask>[1]> = {}) => ({
  db,
  objects,
  runs: trigger.runs,
  logger: logger(),
  timers: clock,
  ...overrides,
});

beforeEach(async () => {
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  dir = mkdtempSync(join(tmpdir(), "symplist-worker-purge-"));
  objects = createLocalObjectStore({ root: dir, env: { NODE_ENV: "test" } });
  clock = new FakeClock(now + 60_000);
  trigger = new FakeTriggerClient({ clock });
  logged = [];
  await setMode("durable");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("account-purge task body (§5.6, §8.8)", () => {
  it("purges objects, owner rows and the users row, writes the tombstone and is idempotent", async () => {
    const userId = await deletedAccount();
    const other = await deletedAccount();
    expect(await runAccountPurgeTask({ userId }, dependencies())).toEqual({
      status: "done",
      invocationCount: 1,
    });
    expect(await db.first(sql("SELECT id FROM users WHERE id = :id", { id: userId }))).toBeNull();
    expect(
      await db.first(
        sql("SELECT status FROM account_deletions WHERE user_id = :id", { id: userId }),
      ),
    ).toEqual({ status: "done" });
    expect(
      await db.first(
        sql("SELECT email_digest FROM account_tombstones WHERE user_id = :id", { id: userId }),
      ),
    ).toEqual({ email_digest: "digest" });
    expect((await objects.list({ prefix: `u/${userId}/`, limit: 10 })).objects).toEqual([]);
    expect((await objects.list({ prefix: `u/${other}/`, limit: 10 })).objects).toHaveLength(2);
    expect(await runAccountPurgeTask({ userId }, dependencies())).toEqual({
      status: "done",
      invocationCount: 1,
    });
    expect(trigger.cancellations).toEqual([]);
    expect(logged.map((entry) => entry.message)).toContain("account_purge.finished");
    expect(JSON.stringify(logged)).not.toContain("@example.test");
  });

  it("refuses payloads that carry anything but the user id", async () => {
    for (const payload of [
      null,
      {},
      { userId: "not-a-uuid" },
      { userId: uuidv7(now), email: "x@y.z" },
    ]) {
      await expect(runAccountPurgeTask(payload, dependencies())).rejects.toMatchObject({
        name: "WorkerError",
        code: "account_purge.payload_invalid",
        retryable: false,
      });
    }
  });

  it("exits without writing when durable mode ended or the intent belongs to an older generation", async () => {
    const userId = await deletedAccount({ generation: 1 });
    await setMode("durable", 2);
    expect(await runAccountPurgeTask({ userId }, dependencies())).toEqual({
      status: "skipped",
      invocationCount: 0,
    });
    await setMode("local", 1);
    expect(await runAccountPurgeTask({ userId }, dependencies())).toEqual({
      status: "skipped",
      invocationCount: 0,
    });
    expect(await db.first(sql("SELECT id FROM users WHERE id = :id", { id: userId }))).toEqual({
      id: userId,
    });
    expect((await objects.list({ prefix: `u/${userId}/`, limit: 10 })).objects).toHaveLength(2);
    expect(await runAccountPurgeTask({ userId: uuidv7(now) }, dependencies())).toEqual({
      status: "skipped",
      invocationCount: 0,
    });
  });

  it("cancels the account's straggler Trigger runs and stops them before purging rows", async () => {
    const userId = await deletedAccount();
    const handle = await trigger.tasks.trigger(
      "simon-run",
      { runId: "r1" },
      { idempotencyKey: "r1" },
    );
    const active = new Map<string, ActiveExecution>([
      [
        "01996d2a-4c00-7000-8000-00000000e001",
        {
          subjectId: "01996d2a-4c00-7000-8000-00000000e001",
          ownerId: userId,
          executor: "trigger",
          executorGeneration: 1,
          triggerRunId: handle.id,
          heartbeatAt: null,
          startedAt: now,
          createdAt: now,
          cancelRequestedAt: now,
        },
      ],
    ]);
    const tracker: ExecutionTracker = {
      listActive: async (query) =>
        [...active.values()].filter(
          (execution) =>
            execution.executor === query.executor &&
            (query.ownerId === undefined || execution.ownerId === query.ownerId),
        ),
      recordDispatch: async () => undefined,
      recordHeartbeat: async () => undefined,
      markInterrupted: async () => false,
      markStopped: async (subjectId) => active.delete(subjectId),
    };
    const contributors: EventsContributor[] = [
      {
        domain: "simon",
        executionKinds: [
          {
            kind: "simon_run",
            triggerTaskId: "simon-run",
            payload: (job) => ({ runId: job.subjectId }),
            tracker: () => tracker,
          },
        ],
      },
    ];
    expect(
      await runAccountPurgeTask({ userId }, dependencies({ eventsContributors: contributors })),
    ).toMatchObject({ status: "done" });
    expect(trigger.cancellations).toEqual([handle.id]);
    expect(active.size).toBe(0);
  });

  it("recovers a straggler's Trigger run id from its dispatched intent", async () => {
    const userId = await deletedAccount();
    const handle = await trigger.tasks.trigger(
      "simon-run",
      { runId: "r2" },
      { idempotencyKey: "r2" },
    );
    const subjectId = "01996d2a-4c00-7000-8000-00000000e003";
    await db.run(
      sql(
        `INSERT INTO dispatch_intents (id, owner_id, kind, subject_id, status, executor, executor_generation,
           trigger_run_id, attempts, created_at, updated_at, dispatched_at, write_id)
         VALUES (:id, :owner, 'simon_run', :subject, 'dispatched', 'trigger', 1, :run, 1, :now, :now, :now, :w)`,
        {
          id: uuidv7(now),
          owner: userId,
          subject: subjectId,
          run: handle.id,
          now: int(now),
          w: newWriteId(),
        },
      ),
    );
    let active = true;
    const tracker: ExecutionTracker = {
      listActive: async (query) =>
        active && query.executor === "trigger"
          ? [
              {
                subjectId,
                ownerId: userId,
                executor: "trigger",
                executorGeneration: 1,
                triggerRunId: null,
                heartbeatAt: null,
                startedAt: now,
                createdAt: now,
                cancelRequestedAt: now,
              },
            ]
          : [],
      recordDispatch: async () => undefined,
      recordHeartbeat: async () => undefined,
      markInterrupted: async () => false,
      markStopped: async () => {
        active = false;
        return true;
      },
    };
    const contributors: EventsContributor[] = [
      {
        domain: "simon",
        executionKinds: [
          {
            kind: "simon_run",
            triggerTaskId: "simon-run",
            payload: (job) => ({ runId: job.subjectId }),
            tracker: () => tracker,
          },
        ],
      },
    ];
    expect(
      await runAccountPurgeTask({ userId }, dependencies({ eventsContributors: contributors })),
    ).toMatchObject({ status: "done" });
    expect(trigger.cancellations).toEqual([handle.id]);
  });

  it("pauses between incomplete invocations and resumes once the blocking run is gone", async () => {
    const userId = await deletedAccount();
    let localRunActive = true;
    const tracker: ExecutionTracker = {
      listActive: async (query) =>
        localRunActive && query.executor === "local"
          ? [
              {
                subjectId: "01996d2a-4c00-7000-8000-00000000e004",
                ownerId: userId,
                executor: "local",
                executorGeneration: 1,
                triggerRunId: null,
                heartbeatAt: null,
                startedAt: now,
                createdAt: now,
                cancelRequestedAt: now,
              },
            ]
          : [],
      recordDispatch: async () => undefined,
      recordHeartbeat: async () => undefined,
      markInterrupted: async () => false,
      markStopped: async () => false,
    };
    const contributors: EventsContributor[] = [
      {
        domain: "simon",
        executionKinds: [
          {
            kind: "simon_run",
            triggerTaskId: "simon-run",
            payload: (job) => ({ runId: job.subjectId }),
            tracker: () => tracker,
          },
        ],
      },
    ];
    const running = runAccountPurgeTask(
      { userId },
      dependencies({ eventsContributors: contributors, pauseMs: 5_000 }),
    );
    // The first invocation cannot finish while the other executor's run is active: it waits.
    await vi.waitFor(() => expect(clock.pendingTimers()).toBe(1));
    localRunActive = false;
    await clock.advance(5_000);
    expect(await running).toEqual({ status: "done", invocationCount: 2 });
  });

  it("throws the retryable account_purge.incomplete when the budget ends with work left", async () => {
    const userId = await deletedAccount();
    const tracker: ExecutionTracker = {
      // A local run of this account is still active: a durable attempt cannot reach it.
      listActive: async (query) =>
        query.executor === "local"
          ? [
              {
                subjectId: "01996d2a-4c00-7000-8000-00000000e002",
                ownerId: userId,
                executor: "local",
                executorGeneration: 1,
                triggerRunId: null,
                heartbeatAt: null,
                startedAt: now,
                createdAt: now,
                cancelRequestedAt: now,
              },
            ]
          : [],
      recordDispatch: async () => undefined,
      recordHeartbeat: async () => undefined,
      markInterrupted: async () => false,
      markStopped: async () => false,
    };
    const contributors: EventsContributor[] = [
      {
        domain: "simon",
        executionKinds: [
          {
            kind: "simon_run",
            triggerTaskId: "simon-run",
            payload: (job) => ({ runId: job.subjectId }),
            tracker: () => tracker,
          },
        ],
      },
    ];
    await expect(
      runAccountPurgeTask(
        { userId },
        dependencies({ eventsContributors: contributors, budgetMs: 0 }),
      ),
    ).rejects.toMatchObject({ code: "account_purge.incomplete", retryable: true });
    expect(await db.first(sql("SELECT id FROM users WHERE id = :id", { id: userId }))).toEqual({
      id: userId,
    });
  });

  it("maps storage and D1 failures to retryable stable codes without detail", async () => {
    const userId = await deletedAccount();
    const failing = {
      ...objects,
      list: async () => {
        throw Object.assign(new Error(`bucket secret-bucket-name for ${userId}`), {
          code: "storage.unavailable",
        });
      },
    } as unknown as LocalObjectStore;
    const error = await runAccountPurgeTask({ userId }, dependencies({ objects: failing })).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({
      name: "WorkerError",
      code: "storage.unavailable",
      retryable: true,
    });
    expect(String((error as Error).message)).not.toContain("secret-bucket-name");
  });
});
