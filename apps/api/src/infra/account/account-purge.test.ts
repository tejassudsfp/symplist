import type { PostHogPersonDeletionClient } from "@symplist/analytics/server";
import type { AccountDeletionService, AccountPurgeResult } from "@symplist/core/account";
import { int, sql, uuidv7 } from "@symplist/db";
import { FakeClock } from "@symplist/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp, type TestAppOptions } from "../../../test/harness.ts";
import {
  ACCOUNT_DELETION,
  ACCOUNT_DELETION_EFFECTS,
} from "../../common/access/access.providers.ts";
import { ExecutionDispatcher } from "../executors/dispatcher.ts";
import { ExecutionRegistry } from "../executors/execution-registry.ts";
import { ExecutorStateService } from "../executors/executor-state.ts";
import { LocalScheduler } from "../scheduler/local-scheduler.ts";
import type { OperationalLog, OperationalLogFields } from "../scheduler/runtime.ts";
import { ACCOUNT_PURGE_JOB, ACCOUNT_PURGE_RUNNER } from "./account-purge.module.ts";
import { AccountPurgeService } from "./account-purge.service.ts";
import { AnalyticsDeletionEffect, posthogDeletionClientFor } from "./analytics-deletion.effect.ts";
import { PurgeDispatchEffect } from "./purge-dispatch.effect.ts";

class Log implements OperationalLog {
  readonly entries: { event: string; fields: OperationalLogFields | undefined }[] = [];
  info(event: string, fields?: OperationalLogFields) {
    this.entries.push({ event, fields });
  }
  warn(event: string, fields?: OperationalLogFields) {
    this.entries.push({ event, fields });
  }
  error(event: string, fields?: OperationalLogFields) {
    this.entries.push({ event, fields });
  }
}

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function boot(options: TestAppOptions = {}): Promise<TestApp> {
  const app = await bootTestApp(options);
  apps.push(app);
  return app;
}

/** Deletes an account through the platform's deletion service, as the deletion endpoint will. */
async function deleteAccount(app: TestApp): Promise<{ id: string; email: string }> {
  const user = await app.createSignedInUser();
  const now = app.clock.now();
  const challengeId = uuidv7(now);
  const authorizationId = uuidv7(now);
  await app.db.batch([
    sql(
      `INSERT INTO otp_challenges (id, user_id, purpose, auth_session_id, code_digest, digest_version,
         created_at, expires_at, consumed_at, write_id)
       VALUES (:id, :user, 'account_delete', :session, 'digest', 1, :now, :exp, :now, 'w')`,
      {
        id: challengeId,
        user: user.id,
        session: user.session.sessionId,
        now: int(now),
        exp: int(now + 600_000),
      },
    ),
    sql(
      `INSERT INTO account_delete_authorizations (id, user_id, auth_session_id, challenge_id, created_at,
         expires_at, consumed_at, write_id)
       VALUES (:id, :user, :session, :challenge, :now, :exp, NULL, 'w')`,
      {
        id: authorizationId,
        user: user.id,
        session: user.session.sessionId,
        challenge: challengeId,
        now: int(now),
        exp: int(now + 600_000),
      },
    ),
  ]);
  await app.objects.put({ key: `u/${user.id}/docs/t1/c1.md.sym`, body: new Uint8Array([1, 2]) });
  const result = await app.inject<AccountDeletionService>(ACCOUNT_DELETION).delete({
    userId: user.id,
    authorizationId,
    authSessionId: user.session.sessionId,
    now,
  });
  expect(result.status).toBe("deleted");
  return { id: user.id, email: user.email };
}

async function deletionStatus(app: TestApp, userId: string) {
  return app.db.first<{ status: string }>(
    sql("SELECT status FROM account_deletions WHERE user_id = :user", { user: userId }),
  );
}

describe("account purge runtime in local mode (§5.6, §8.8)", () => {
  it("registers the runner, dispatches the purge intent after deletion and purges in process", async () => {
    const app = await boot();
    expect(app.inject(ACCOUNT_PURGE_RUNNER)).toBeDefined();
    const effects = app.inject<{ name: string }[]>(ACCOUNT_DELETION_EFFECTS);
    expect(effects.map((effect) => effect.name)).toEqual([
      "analytics_person_deletion",
      "account_purge_dispatch",
    ]);
    const deleted = await deleteAccount(app);
    expect(await deletionStatus(app, deleted.id)).toEqual({ status: "pending" });

    // The deletion effect kicked the dispatcher; its pass runs the local handler.
    await app.clock.advance(0);
    await vi.waitFor(async () =>
      expect(await deletionStatus(app, deleted.id)).toEqual({ status: "done" }),
    );
    expect(
      await app.db.first(sql("SELECT id FROM users WHERE id = :id", { id: deleted.id })),
    ).toBeNull();
    expect(
      await app.db.first(
        sql("SELECT user_id FROM account_tombstones WHERE user_id = :id", { id: deleted.id }),
      ),
    ).toEqual({ user_id: deleted.id });
    expect((await app.objects.list({ prefix: `u/${deleted.id}/`, limit: 10 })).objects).toEqual([]);
    expect(
      await app.db.first(
        sql("SELECT status, executor FROM dispatch_intents WHERE subject_id = :id", {
          id: deleted.id,
        }),
      ),
    ).toEqual({ status: "dispatched", executor: "local" });
    // Local mode never reaches Trigger.
    expect(app.trigger.triggers).toEqual([]);
    expect(app.scanObjectsFor(deleted.email)).toEqual([]);
  });

  it("resumes pending purges from the hourly background job", async () => {
    const app = await boot({ runtime: { backgroundLoops: true } });
    expect(() =>
      app.inject<LocalScheduler>(LocalScheduler).registerHourlyJob({
        name: ACCOUNT_PURGE_JOB.name,
        run: async () => undefined,
      }),
    ).toThrow(/already registered/);
    const deleted = await deleteAccount(app);
    // A restart lost the dispatch: the intent is dispatched but the purge never ran.
    await app.db.run(
      sql(
        `UPDATE dispatch_intents SET status = 'dispatched', executor = 'local', dispatched_at = :now
         WHERE subject_id = :id`,
        { now: int(app.clock.now()), id: deleted.id },
      ),
    );
    expect(await deletionStatus(app, deleted.id)).toEqual({ status: "pending" });
    // The fake clock starts at 09:00 UTC; the job fires at :05.
    await app.clock.advance(5 * 60_000);
    await vi.waitFor(async () =>
      expect(await deletionStatus(app, deleted.id)).toEqual({ status: "done" }),
    );
  });

  it("registers no local purge in durable mode, where the account-purge task receives an ids-only payload", async () => {
    const app = await boot({
      env: {
        DURABLE: "true",
        TRIGGER_SECRET_KEY: "tr_dev_platformtest",
        TRIGGER_PROJECT_REF: "proj_platformtest",
      },
    });
    expect(
      app.inject<ExecutionRegistry>(ExecutionRegistry).localHandler("account_purge"),
    ).toBeUndefined();
    const deleted = await deleteAccount(app);
    await app.inject<ExecutionDispatcher>(ExecutionDispatcher).dispatchPending();
    expect(app.trigger.triggers).toMatchObject([
      {
        taskIdentifier: "account-purge",
        payload: { userId: deleted.id },
        options: { idempotencyKey: deleted.id },
      },
    ]);
    expect(await deletionStatus(app, deleted.id)).toEqual({ status: "pending" });
  });
});

describe("AccountPurgeService", () => {
  const userId = "01996d2a-4c00-7000-8000-00000000c001";

  function service(options: {
    results: AccountPurgeResult["status"][];
    mode?: "local" | "durable";
    generations?: number[];
    maxInvocations?: number;
  }) {
    const results = [...options.results];
    const generations = [...(options.generations ?? [])];
    const runner = {
      run: vi.fn(async () => {
        const status = results.shift() ?? "done";
        return status === "incomplete" ? { status, stepsDone: [] } : { status };
      }),
    };
    const log = new Log();
    const purges = new AccountPurgeService({
      runner: runner as never,
      state: {
        readFresh: async () =>
          ({ mode: options.mode ?? "local", generation: generations.shift() ?? 4 }) as never,
      },
      db: { all: async () => [] } as never,
      log,
      ...(options.maxInvocations === undefined ? {} : { maxInvocations: options.maxInvocations }),
    });
    return { purges, runner, log };
  }

  const context = (generation = 4) => ({ generation, signal: new AbortController().signal });

  it("runs bounded invocations until the purge is done or the budget ends", async () => {
    const done = service({ results: ["incomplete", "incomplete", "done"] });
    expect(await done.purges.purge(userId, context())).toBe("done");
    expect(done.runner.run).toHaveBeenCalledTimes(3);
    const budget = service({
      results: ["incomplete", "incomplete", "incomplete"],
      maxInvocations: 2,
    });
    expect(await budget.purges.purge(userId, context())).toBe("incomplete");
    expect(budget.runner.run).toHaveBeenCalledTimes(2);
  });

  it("stops without writing when the executor mode or generation moved", async () => {
    const durable = service({ results: ["done"], mode: "durable" });
    expect(await durable.purges.purge(userId, context())).toBe("stale_generation");
    expect(durable.runner.run).not.toHaveBeenCalled();
    const moved = service({ results: ["incomplete", "done"], generations: [4, 5] });
    expect(await moved.purges.purge(userId, context())).toBe("stale_generation");
    expect(moved.runner.run).toHaveBeenCalledTimes(1);
  });

  it("purges an account in one call at a time and honors aborts", async () => {
    let release: () => void = () => undefined;
    const runner = {
      run: vi.fn(
        () =>
          new Promise<AccountPurgeResult>((resolve) => {
            release = () => resolve({ status: "done" });
          }),
      ),
    };
    const purges = new AccountPurgeService({
      runner: runner as never,
      state: { readFresh: async () => ({ mode: "local", generation: 4 }) as never },
      db: {} as never,
      log: new Log(),
    });
    const first = purges.purge(userId, context());
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    expect(await purges.purge(userId, context())).toBe("busy");
    release();
    expect(await first).toBe("done");
    const controller = new AbortController();
    controller.abort();
    expect(await purges.purge(userId, { generation: 4, signal: controller.signal })).toBe(
      "aborted",
    );
  });

  it("resumes pending deletions oldest first and keeps going after one fails", async () => {
    const other = "01996d2a-4c00-7000-8000-00000000c002";
    const runner = {
      run: vi.fn(async (id: string) => {
        if (id === userId)
          throw Object.assign(new Error("r2 down"), { code: "storage.unavailable" });
        return { status: "done" as const };
      }),
    };
    const log = new Log();
    const all = vi.fn(async () => [{ user_id: userId }, { user_id: other }]);
    const purges = new AccountPurgeService({
      runner: runner as never,
      state: { readFresh: async () => ({ mode: "local", generation: 4 }) as never },
      db: { all } as never,
      log,
    });
    expect(await purges.resumePending(context())).toEqual({ checked: 2, done: 1 });
    expect(log.entries.map((entry) => entry.event)).toContain("account.purge_failed");
    expect(JSON.stringify(log.entries)).not.toContain("r2 down");
  });
});

describe("account deletion effects (§5.6)", () => {
  const event = {
    userId: "01996d2a-4c00-7000-8000-00000000d001",
    analyticsId: "a1",
    committedAt: 1,
  };

  it("requests PostHog person deletion and records the request when credentials are configured", async () => {
    const app = await boot();
    const deleted = await deleteAccount(app);
    const client: PostHogPersonDeletionClient = {
      findPersonUuids: vi.fn(),
      eventDeletionStatus: vi.fn(),
      requestDeletion: vi.fn(async () => ({
        status: 202 as const,
        personsFound: 1,
        personsDeleted: 1,
        eventsQueuedForDeletion: true,
        recordingsQueuedForDeletion: true,
        personUuids: [uuidv7()],
        failedPersonUuids: [],
      })),
    };
    const log = new Log();
    const clock = new FakeClock(app.clock.now() + 5_000);
    const effect = new AnalyticsDeletionEffect({ client, db: app.db, now: () => clock.now(), log });
    expect(effect.enabled).toBe(true);
    await effect.afterCommit({
      ...event,
      userId: deleted.id,
      analyticsId: "3f1c-random-analytics",
    });
    expect(client.requestDeletion).toHaveBeenCalledWith("3f1c-random-analytics");
    expect(
      await app.db.first(
        sql(
          "SELECT analytics_deletion_requested_at AS at FROM account_deletions WHERE user_id = :id",
          {
            id: deleted.id,
          },
        ),
      ),
    ).toEqual({ at: clock.now() });
    expect(log.entries.map((entry) => entry.event)).toEqual([
      "account.analytics_deletion_requested",
    ]);
    expect(JSON.stringify(log.entries)).not.toContain("3f1c-random-analytics");
  });

  it("does nothing without deletion credentials or without an analytics id, and propagates failures", async () => {
    expect(posthogDeletionClientFor({})).toBeNull();
    expect(
      posthogDeletionClientFor({ POSTHOG_PERSONAL_API_KEY: "phx_abcdefghijklmnop" }),
    ).toBeNull();
    expect(
      posthogDeletionClientFor({
        POSTHOG_PERSONAL_API_KEY: "phx_abcdefghijklmnop",
        POSTHOG_PROJECT_ID: "42",
      }),
    ).not.toBeNull();
    const db = { run: vi.fn() };
    const disabled = new AnalyticsDeletionEffect({
      client: null,
      db: db as never,
      now: () => 1,
      log: new Log(),
    });
    expect(disabled.enabled).toBe(false);
    await disabled.afterCommit(event);
    const requestDeletion = vi.fn(async () => {
      throw Object.assign(new Error("unauthorized"), { code: "analytics.deletion_unauthorized" });
    });
    const client = { requestDeletion } as unknown as PostHogPersonDeletionClient;
    const noId = new AnalyticsDeletionEffect({
      client,
      db: db as never,
      now: () => 1,
      log: new Log(),
    });
    await noId.afterCommit({ ...event, analyticsId: null });
    expect(requestDeletion).not.toHaveBeenCalled();
    await expect(noId.afterCommit(event)).rejects.toMatchObject({
      code: "analytics.deletion_unauthorized",
    });
    expect(db.run).not.toHaveBeenCalled();
  });

  it("kicks the dispatcher after the deletion commits", async () => {
    const kick = vi.fn();
    await new PurgeDispatchEffect({ kick }).afterCommit();
    expect(kick).toHaveBeenCalledTimes(1);
  });
});

describe("executor state for the purge", () => {
  it("records the configured mode at bootstrap, which the purge generation check reads", async () => {
    const app = await boot();
    expect(await app.inject<ExecutorStateService>(ExecutorStateService).readFresh()).toMatchObject({
      mode: "local",
    });
  });
});
