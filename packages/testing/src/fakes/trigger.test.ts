import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock.ts";
import {
  FakeTriggerApiError,
  FakeTriggerClient,
  hashTriggerIdempotencyKey,
  parseTriggerDuration,
} from "./trigger.ts";

const marker = "MARKER-simon-9c21";

function setup(environment?: "DEVELOPMENT" | "PRODUCTION") {
  const clock = new FakeClock(Date.UTC(2026, 8, 15, 10, 0, 0));
  const trigger = new FakeTriggerClient({ clock, ...(environment ? { environment } : {}) });
  return { clock, trigger };
}

describe("FakeTriggerClient tasks", () => {
  it("triggers a run with a handle, records the call and executes it on demand", async () => {
    const { trigger } = setup();
    trigger.registerTask("simon-run", async (payload, { ctx }) => ({
      runId: (payload as { runId: string }).runId,
      attempt: ctx.attempt.number,
    }));

    const handle = await trigger.tasks.trigger(
      "simon-run",
      { runId: "r1" },
      { idempotencyKey: "r1", tags: ["run:r1"] },
    );
    expect(handle).toEqual({
      id: "run_fake000001",
      publicAccessToken: "fake_public_token_run_fake000001",
      taskIdentifier: "simon-run",
    });
    expect(await trigger.runs.retrieve(handle.id)).toMatchObject({
      status: "QUEUED",
      isQueued: true,
      isCompleted: false,
      tags: ["run:r1"],
      idempotencyKey: "r1",
    });

    const finished = await trigger.runNext();
    expect(finished).toMatchObject({
      status: "COMPLETED",
      isSuccess: true,
      isCompleted: true,
      output: { runId: "r1", attempt: 1 },
      attemptCount: 1,
    });
    expect(trigger.triggers).toEqual([
      {
        via: "trigger",
        taskIdentifier: "simon-run",
        payload: { runId: "r1" },
        options: { idempotencyKey: "r1", tags: ["run:r1"] },
        runId: handle.id,
        deduplicated: false,
        parentRunId: null,
      },
    ]);
    expect(await trigger.runNext()).toBeNull();
  });

  it("deduplicates on idempotency keys per task until the key's TTL passes", async () => {
    const { clock, trigger } = setup();
    trigger.registerTask("search-index", async () => "ok");
    const first = await trigger.tasks.trigger(
      "search-index",
      { ownerId: "u1" },
      { idempotencyKey: "search:u1:1", idempotencyKeyTTL: "1h" },
    );
    const again = await trigger.tasks.trigger(
      "search-index",
      { ownerId: "u1" },
      { idempotencyKey: "search:u1:1" },
    );
    const otherTask = await trigger.tasks.trigger(
      "account-purge",
      { ownerId: "u1" },
      { idempotencyKey: "search:u1:1" },
    );
    expect(again.id).toBe(first.id);
    expect(otherTask.id).not.toBe(first.id);
    expect(trigger.triggers.map((record) => record.deduplicated)).toEqual([false, true, false]);

    await trigger.execute(first.id);
    const afterSuccess = await trigger.tasks.trigger(
      "search-index",
      {},
      { idempotencyKey: "search:u1:1" },
    );
    expect(afterSuccess.id).toBe(first.id);

    await clock.advance(61 * 60_000);
    const afterTtl = await trigger.tasks.trigger(
      "search-index",
      {},
      { idempotencyKey: "search:u1:1" },
    );
    expect(afterTtl.id).not.toBe(first.id);

    // Backend code has no run context, so a raw key is reset with an explicit global scope.
    await expect(trigger.idempotencyKeys.reset("search-index", "search:u1:1")).rejects.toThrow(
      /parentRunId is required/,
    );
    await trigger.idempotencyKeys.reset("search-index", "search:u1:1", { scope: "global" });
    const afterReset = await trigger.tasks.trigger(
      "search-index",
      {},
      { idempotencyKey: "search:u1:1" },
    );
    expect(afterReset.id).not.toBe(afterTtl.id);
  });

  it("releases the key of a failed run and keeps the key of a cancelled run", async () => {
    const { trigger } = setup();
    trigger.registerTask(
      "document-git",
      async () => {
        throw new Error("git failed");
      },
      { maxAttempts: 2 },
    );
    const failing = await trigger.tasks.trigger(
      "document-git",
      { op: "commit" },
      { idempotencyKey: "tool-call-1" },
    );
    const failed = await trigger.execute(failing.id);
    expect(failed).toMatchObject({
      status: "FAILED",
      isFailed: true,
      isCompleted: true,
      attemptCount: 2,
    });
    expect(failed.error).toMatchObject({ name: "Error", message: "git failed" });
    expect(trigger.errors.map((record) => record.attempt)).toEqual([1, 2]);
    const retried = await trigger.tasks.trigger(
      "document-git",
      { op: "commit" },
      { idempotencyKey: "tool-call-1" },
    );
    expect(retried.id).not.toBe(failing.id);

    const cancelled = await trigger.tasks.trigger(
      "document-git",
      {},
      { idempotencyKey: "tool-call-2" },
    );
    await trigger.runs.cancel(cancelled.id);
    const same = await trigger.tasks.trigger("document-git", {}, { idempotencyKey: "tool-call-2" });
    expect(same.id).toBe(cancelled.id);
  });

  it("delays runs, expires unstarted runs after their TTL and reschedules delayed runs", async () => {
    const { clock, trigger } = setup();
    trigger.registerTask("search-index", async () => "indexed");
    const delayed = await trigger.tasks.trigger("search-index", {}, { delay: "30s", ttl: "10m" });
    expect(await trigger.runs.retrieve(delayed.id)).toMatchObject({
      status: "DELAYED",
      isQueued: true,
    });
    expect(await trigger.runNext()).toBeNull();

    await trigger.runs.reschedule(delayed.id, { delay: "1m" });
    await clock.advance(45_000);
    expect((await trigger.runs.retrieve(delayed.id)).status).toBe("DELAYED");
    await clock.advance(20_000);
    expect((await trigger.runs.retrieve(delayed.id)).status).toBe("QUEUED");

    const stale = await trigger.tasks.trigger("search-index", {}, { ttl: 60 });
    await clock.advance(61_000);
    expect(await trigger.runs.retrieve(stale.id)).toMatchObject({
      status: "EXPIRED",
      isFailed: true,
      isCompleted: true,
    });
    await expect(trigger.runs.reschedule(stale.id, { delay: "1m" })).rejects.toBeInstanceOf(
      FakeTriggerApiError,
    );
    expect(await trigger.runUntilIdle()).toBe(1);
  });

  it("cancels queued and executing runs, aborting the handler's signal, and ignores finished runs", async () => {
    const { trigger } = setup();
    let release: () => void = () => undefined;
    let observedAbort = false;
    trigger.registerTask("simon-run", async (_payload, { signal }) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { late: true };
    });

    const queued = await trigger.tasks.trigger("simon-run", { runId: "q" });
    await trigger.runs.cancel(queued.id);
    expect(await trigger.runs.retrieve(queued.id)).toMatchObject({
      status: "CANCELED",
      isCancelled: true,
      isCompleted: false,
    });

    const running = await trigger.tasks.trigger("simon-run", { runId: "r" });
    const execution = trigger.execute(running.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await trigger.runs.retrieve(running.id)).status).toBe("EXECUTING");
    await trigger.runs.cancel(running.id);
    expect(observedAbort).toBe(true);
    release();
    expect((await execution).status).toBe("CANCELED");
    expect(trigger.outputs.at(-1)).toEqual({
      runId: running.id,
      output: { late: true },
      discarded: true,
    });

    await trigger.runs.cancel(running.id);
    expect(trigger.cancellations).toEqual([queued.id, running.id, running.id]);
    await expect(trigger.runs.cancel("run_missing")).rejects.toMatchObject({ status: 404 });
  });

  it("drives reconciler states by hand", async () => {
    const { trigger } = setup();
    const crashed = await trigger.tasks.trigger("simon-run", { runId: "c" });
    trigger.startRun(crashed.id);
    expect(await trigger.runs.retrieve(crashed.id)).toMatchObject({
      status: "EXECUTING",
      isExecuting: true,
    });
    trigger.failRun(crashed.id, "CRASHED", new Error("out of memory"));
    expect(await trigger.runs.retrieve(crashed.id)).toMatchObject({
      status: "CRASHED",
      isFailed: true,
    });

    const done = await trigger.tasks.trigger("simon-run", { runId: "d" });
    trigger.startRun(done.id);
    trigger.completeRun(done.id, { steps: 3 });
    expect(await trigger.runs.retrieve(done.id)).toMatchObject({
      status: "COMPLETED",
      output: { steps: 3 },
    });
    expect(() => trigger.completeRun(done.id, {})).toThrow(FakeTriggerApiError);
    expect(() => trigger.startRun(done.id)).toThrow(FakeTriggerApiError);
  });

  it("runs triggerAndWait children in process, marks the parent WAITING, and returns results", async () => {
    const { trigger } = setup();
    const parentStatuses: string[] = [];
    trigger.registerTask("document-git", async (payload) => {
      const run = trigger.allRuns().find((entry) => entry.taskIdentifier === "simon-run");
      parentStatuses.push(run?.status ?? "none");
      if ((payload as { op: string }).op === "bad") throw new Error("bundle verify failed");
      return { commitId: "c1" };
    });
    trigger.registerTask("simon-run", async () => {
      const ok = await trigger.tasks.triggerAndWait(
        "document-git",
        { op: "commit" },
        { idempotencyKey: "call-1" },
      );
      const cached = await trigger.tasks.triggerAndWait(
        "document-git",
        { op: "commit" },
        { idempotencyKey: "call-1" },
      );
      const bad = await trigger.tasks.triggerAndWait("document-git", { op: "bad" });
      return { ok, cached, bad };
    });

    const parent = await trigger.tasks.trigger("simon-run", { runId: "p" });
    const result = await trigger.execute(parent.id);
    const output = result.output as {
      ok: { ok: boolean; output: unknown; id: string };
      cached: { ok: boolean; id: string };
      bad: { ok: boolean; error: unknown };
    };
    expect(output.ok).toMatchObject({
      ok: true,
      output: { commitId: "c1" },
      taskIdentifier: "document-git",
    });
    expect(output.cached).toMatchObject({ ok: true, id: output.ok.id });
    expect(output.bad).toMatchObject({ ok: false, error: { message: "bundle verify failed" } });
    expect(parentStatuses).toEqual(["WAITING", "WAITING"]);
    expect(trigger.triggers.filter((record) => record.parentRunId === parent.id)).toHaveLength(3);
    expect(result.status).toBe("COMPLETED");

    // Like the SDK, backend code cannot wait on a run.
    await expect(trigger.tasks.triggerAndWait("document-git", {})).rejects.toThrow(
      "triggerAndWait can only be used from inside a task.run()",
    );
    trigger.registerTask("waits-on-unregistered", async () =>
      trigger.tasks.triggerAndWait("unregistered", {}),
    );
    const waiting = await trigger.tasks.trigger("waits-on-unregistered", {});
    const failed = await trigger.execute(waiting.id);
    expect(failed.status).toBe("FAILED");
    expect(trigger.errors.at(-1)?.error).toMatchObject({ status: 404 });
  });

  it("scopes raw idempotency keys to the parent run, as the SDK 4.6 does", async () => {
    const { trigger } = setup();
    expect(hashTriggerIdempotencyKey(["reminder/occ-1/email"])).toBe(
      "b1d16824bbc78197156e5a9f1a4ca5de05a13e8128fd66b9b6e57979ee6501fa",
    );
    expect(hashTriggerIdempotencyKey(["commit", "t1", "3"])).toBe(
      "b56ac664f46cbf93790e9bf6c2d55e9215cc5324c79b27587c222dfebd5dcc98",
    );

    trigger.registerTask("document-git", async () => ({ commitId: "c1" }));
    trigger.registerTask("simon-run", async () => {
      const raw = await trigger.tasks.trigger("document-git", {}, { idempotencyKey: "call-1" });
      const again = await trigger.tasks.trigger("document-git", {}, { idempotencyKey: "call-1" });
      const global = await trigger.tasks.trigger(
        "document-git",
        {},
        { idempotencyKey: await trigger.idempotencyKeys.create("call-1", { scope: "global" }) },
      );
      return { raw: raw.id, again: again.id, global: global.id };
    });

    // A Symplist retry is a new Trigger run: the same raw tool-call key does not deduplicate.
    const first = await trigger.tasks.trigger("simon-run", {});
    const retry = await trigger.tasks.trigger("simon-run", {});
    type Ids = { raw: string; again: string; global: string };
    const one = (await trigger.execute(first.id)).output as Ids;
    const two = (await trigger.execute(retry.id)).output as Ids;
    expect(one.again).toBe(one.raw);
    expect(two.raw).not.toBe(one.raw);
    expect(two.global).toBe(one.global);

    // From backend code a raw key has no run to scope to, so it equals the global key.
    const backend = await trigger.tasks.trigger("document-git", {}, { idempotencyKey: "call-1" });
    expect(backend.id).toBe(one.global);
    const child = await trigger.runs.retrieve(one.raw);
    expect(child).toMatchObject({ idempotencyKey: "call-1", idempotencyKeyScope: "run" });

    // Resetting a run-scoped raw key from backend code needs the parent run id.
    expect(
      await trigger.idempotencyKeys.reset("document-git", "call-1", {
        scope: "run",
        parentRunId: first.id,
      }),
    ).toEqual({ id: one.raw });
    const runScopedHash = hashTriggerIdempotencyKey(["call-1", first.id]);
    expect(
      await trigger.idempotencyKeys.reset("document-git", "call-1", {
        scope: "run",
        parentRunId: first.id,
      }),
    ).toEqual({ id: runScopedHash });
    // The global key was untouched by the run-scoped reset.
    const stillGlobal = await trigger.tasks.trigger(
      "document-git",
      {},
      { idempotencyKey: "call-1" },
    );
    expect(stillGlobal.id).toBe(one.global);
  });

  it("batch-triggers runs", async () => {
    const { trigger } = setup();
    const batch = await trigger.tasks.batchTrigger("search-index", [
      { payload: { ownerId: "a" } },
      { payload: { ownerId: "b" }, options: { idempotencyKey: "b" } },
    ]);
    // The SDK 4.6 handle has no run ids.
    expect(batch).toEqual({
      batchId: "batch_fake000001",
      runCount: 2,
      publicAccessToken: "fake_public_token_batch_fake000001",
    });
    expect(trigger.batchRuns(batch.batchId).map((run) => run.idempotencyKey)).toEqual([
      undefined,
      "b",
    ]);
    expect(trigger.triggers.map((record) => record.via)).toEqual(["batchTrigger", "batchTrigger"]);

    // A batch-level key gives each item `[key, index]`, so a repeated batch deduplicates per item.
    const keyed = await trigger.tasks.batchTrigger(
      "search-index",
      [{ payload: { ownerId: "c" } }, { payload: { ownerId: "d" } }],
      { idempotencyKey: "reindex-7" },
    );
    const repeat = await trigger.tasks.batchTrigger(
      "search-index",
      [{ payload: { ownerId: "c" } }, { payload: { ownerId: "d" } }],
      { idempotencyKey: "reindex-7" },
    );
    const keyedIds = trigger.batchRuns(keyed.batchId).map((run) => run.id);
    expect(trigger.batchRuns(repeat.batchId).map((run) => run.id)).toEqual(keyedIds);
    expect(trigger.batchRuns(keyed.batchId).map((run) => run.idempotencyKey)).toEqual([
      "reindex-7-0",
      "reindex-7-1",
    ]);
    expect(() => trigger.batchRuns("batch_missing")).toThrow(FakeTriggerApiError);
  });

  it("validates tags, keys, payload sizes and durations like the platform", async () => {
    const { trigger } = setup();
    await expect(
      trigger.tasks.trigger("t", {}, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }),
    ).rejects.toBeInstanceOf(FakeTriggerApiError);
    await expect(trigger.tasks.trigger("t", {}, { idempotencyKey: "" })).rejects.toBeInstanceOf(
      FakeTriggerApiError,
    );
    await expect(
      trigger.tasks.trigger("t", { blob: "x".repeat(3 * 1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(trigger.tasks.trigger("", {})).rejects.toBeInstanceOf(FakeTriggerApiError);
    expect(parseTriggerDuration("15m")).toBe(900_000);
    expect(parseTriggerDuration("2w")).toBe(1_209_600_000);
    expect(() => parseTriggerDuration("soon")).toThrow(FakeTriggerApiError);
    await expect(trigger.runs.retrieve("run_nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("FakeTriggerClient logger and metadata", () => {
  it("scopes metadata to the executing run and records every write and log call", async () => {
    const { trigger } = setup();
    trigger.registerTask("simon-run", async () => {
      trigger.metadata.set("steps", 1).increment("steps", 2).append("codes", "tool.ok");
      trigger.metadata.append("codes", "tool.retry").remove("codes", "tool.ok");
      trigger.logger.info("simon.step", { runId: "r1", step: 3 });
      return trigger.metadata.current();
    });
    trigger.logger.warn("outside a run");
    trigger.metadata.set("ignored", true);

    const handle = await trigger.tasks.trigger(
      "simon-run",
      {},
      { metadata: { executor: "trigger" } },
    );
    const run = await trigger.execute(handle.id);
    expect(run.metadata).toEqual({ executor: "trigger", steps: 3, codes: ["tool.retry"] });
    expect(run.output).toEqual({ executor: "trigger", steps: 3, codes: ["tool.retry"] });
    expect(trigger.metadata.current()).toBeUndefined();
    expect(trigger.logs).toEqual([
      { level: "warn", message: "outside a run", properties: undefined, runId: null },
      {
        level: "info",
        message: "simon.step",
        properties: { runId: "r1", step: 3 },
        runId: handle.id,
      },
    ]);
    expect(trigger.metadataWrites.map((write) => [write.runId, write.operation])).toEqual([
      [null, "set"],
      [handle.id, "set"],
      [handle.id, "increment"],
      [handle.id, "append"],
      [handle.id, "append"],
      [handle.id, "remove"],
    ]);
  });

  it("rejects metadata over 256KB", async () => {
    const { trigger } = setup();
    trigger.registerTask("big", async () => {
      trigger.metadata.set("blob", "x".repeat(257 * 1024));
    });
    const handle = await trigger.tasks.trigger("big", {});
    expect((await trigger.execute(handle.id)).status).toBe("FAILED");
  });
});

describe("FakeTriggerClient marker search (§8.3)", () => {
  it("finds a marker in every Trigger-hosted sink it reaches", async () => {
    const { trigger } = setup();
    trigger.registerTask("leaky", async () => {
      trigger.logger.error(`failed on ${marker}`, { detail: marker });
      trigger.metadata.set("preview", marker);
      throw new Error(`provider said ${marker}`);
    });
    trigger.registerTask("leaky-output", async () => ({ text: marker }));

    const leaky = await trigger.tasks.trigger(
      "leaky",
      { message: marker },
      {
        tags: [`t:${marker}`],
        idempotencyKey: marker,
        metadata: { note: marker },
        concurrencyKey: marker,
      },
    );
    await trigger.execute(leaky.id);
    const output = await trigger.tasks.trigger("leaky-output", {});
    await trigger.execute(output.id);
    await trigger.schedules.create({ task: "leaky", cron: "0 * * * *", externalId: marker });

    const sinks = new Set(trigger.findMarker(marker).map((hit) => hit.sink));
    expect([...sinks].sort()).toEqual(
      [
        "error",
        "idempotencyKey",
        "log",
        "metadata",
        "options",
        "output",
        "payload",
        "schedule",
        "tags",
      ].sort(),
    );
  });

  it("reports nothing for an ids-only run", async () => {
    const { trigger } = setup();
    trigger.registerTask("simon-run", async (payload) => {
      trigger.logger.info("simon.run_end", {
        runId: (payload as { runId: string }).runId,
        steps: 2,
      });
      trigger.metadata.set("steps", 2);
      return { status: "completed" };
    });
    const handle = await trigger.tasks.trigger(
      "simon-run",
      { runId: "0192f0a0-0000-7000-8000-000000000001" },
      { idempotencyKey: "0192f0a0-0000-7000-8000-000000000001", tags: ["kind:turn"] },
    );
    await trigger.execute(handle.id);
    expect(trigger.findMarker(marker)).toEqual([]);
  });

  it("records payload snapshots so later mutation cannot hide a leak", async () => {
    const { trigger } = setup();
    const payload = { message: marker };
    await trigger.tasks.trigger("simon-run", payload);
    payload.message = "scrubbed later";
    expect(trigger.findMarker(marker).map((hit) => hit.sink)).toEqual(["payload"]);
  });
});

describe("FakeTriggerClient schedules", () => {
  it("creates, deduplicates, lists, updates, deactivates and deletes imperative schedules", async () => {
    const { trigger } = setup();
    const created = await trigger.schedules.create({
      task: "reminder-scan",
      cron: "0,15,30 * * * *",
      timezone: "UTC",
      deduplicationKey: "prod:scan",
    });
    const deduplicated = await trigger.schedules.create({
      task: "reminder-scan",
      cron: "0 * * * *",
      deduplicationKey: "prod:scan",
    });
    expect(deduplicated.id).toBe(created.id);
    expect(deduplicated.generator.expression).toBe("0 * * * *");
    expect((await trigger.schedules.list()).pagination.count).toBe(1);

    const updated = await trigger.schedules.update(created.id, {
      task: "reminder-scan",
      cron: "5 * * * *",
      timezone: "Asia/Kolkata",
    });
    expect(updated).toMatchObject({ timezone: "Asia/Kolkata", active: true });
    expect((await trigger.schedules.deactivate(created.id)).active).toBe(false);
    expect(await trigger.fireSchedule(created.id)).toBeNull();
    expect((await trigger.schedules.activate(created.id)).active).toBe(true);
    expect(await trigger.schedules.del(created.id)).toEqual({ id: created.id });
    await expect(trigger.schedules.retrieve(created.id)).rejects.toMatchObject({ status: 404 });
    await expect(trigger.schedules.create({ task: "x", cron: "* * * *" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      trigger.schedules.create({ task: "x", cron: "0 * * * *", timezone: "Nowhere/City" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("fires declarative schedules only in their environments with the schedule payload", async () => {
    const production = setup("PRODUCTION");
    const scans: unknown[] = [];
    production.trigger.registerTask("reminder-scan", async (payload) => {
      scans.push(payload);
    });
    const schedule = production.trigger.declareSchedule({
      task: "reminder-scan",
      cron: {
        pattern: "0,15,30 * * * *",
        timezone: "UTC",
        environments: ["PRODUCTION", "STAGING"],
      },
    });
    await expect(
      production.trigger.schedules.update(schedule.id, {
        task: "reminder-scan",
        cron: "0 * * * *",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(production.trigger.schedules.del(schedule.id)).rejects.toMatchObject({
      status: 400,
    });

    const first = await production.trigger.fireSchedule(schedule.id);
    await production.clock.advance(15 * 60_000);
    const second = await production.trigger.fireSchedule(schedule.id);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await production.trigger.runUntilIdle();
    expect(scans).toEqual([
      {
        type: "DECLARATIVE",
        timestamp: new Date(Date.UTC(2026, 8, 15, 10, 0, 0)),
        lastTimestamp: undefined,
        timezone: "UTC",
        scheduleId: schedule.id,
        externalId: undefined,
        upcoming: [],
      },
      expect.objectContaining({
        timestamp: new Date(Date.UTC(2026, 8, 15, 10, 15, 0)),
        lastTimestamp: new Date(Date.UTC(2026, 8, 15, 10, 0, 0)),
      }),
    ]);

    const development = setup("DEVELOPMENT");
    const devSchedule = development.trigger.declareSchedule({
      task: "reminder-scan",
      cron: {
        pattern: "0,15,30 * * * *",
        timezone: "UTC",
        environments: ["PRODUCTION", "STAGING"],
      },
    });
    expect(await development.trigger.fireSchedule(devSchedule.id)).toBeNull();
  });
});
