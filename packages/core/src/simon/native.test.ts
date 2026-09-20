import { type TaskScheduleToolInput, taskIdSchema } from "@symplist/contracts";
import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { SimonNativeSession } from "./native.ts";
import { SimonRepository } from "./repository.ts";
import type { ClaimedSimonRun } from "./types.ts";

let env: DocumentsTestEnvironment;
let repository: SimonRepository;
const claims: ClaimedSimonRun[] = [];
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  repository = new SimonRepository({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: 24,
  });
});
afterEach(async () => {
  for (const claim of claims.splice(0)) repository.releaseClaim(claim);
  vi.restoreAllMocks();
  await env.close();
});
async function session(executor: "local" | "trigger" = "local", quick = true) {
  await env.db.run(
    sql("UPDATE executor_state SET mode=:mode WHERE id=1", {
      mode: executor === "local" ? "local" : "durable",
    }),
  );
  const owner = await env.createUser();
  const taskId = quick ? null : await env.createTask(owner);
  const conversation = await repository.createConversation(owner, taskId);
  const accepted = await repository.acceptMessage(owner, conversation, "native-test", {
    text: "Organize my work",
    tier: "fast",
  });
  const claim = await repository.claim(accepted.runId ?? "", executor);
  if (!claim) throw new Error("Expected claim");
  claims.push(claim);
  const changed = vi.fn(async () => {});
  const tools = new SimonNativeSession(repository, claim, {
    scheduling: { remindersEnabled: true, emailEnabled: false, defaultZone: "UTC" },
    onScheduleChanged: changed,
  });
  return { tools, claim, owner, changed };
}
const deadline = (taskId: string): TaskScheduleToolInput => ({
  operation: "set_deadline",
  taskId,
  expectedVersion: 0,
  deadline: { kind: "date", date: "2026-10-01", zone: "Asia/Kathmandu" },
});

describe("claimed native task and scheduling tools", () => {
  it("fences a generation change after task planning but before the deciding batch", async () => {
    const { tools } = await session();
    const batch = env.db.batch.bind(env.db);
    let raced = false;
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (!raced && statements.some((statement) => statement.sql.includes("INSERT INTO tasks"))) {
        raced = true;
        await env.db.run(sql("UPDATE executor_state SET generation=generation+1 WHERE id=1"));
      }
      return batch(statements, options);
    });
    await expect(tools.create({ title: "Must not commit" }, "raced_create")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(raced).toBe(true);
    expect(await env.count("tasks")).toBe(0);
  });

  it("fences cancellation after schedule read but before its deciding save", async () => {
    const { tools, claim, changed } = await session();
    const task = await tools.create({ title: "Owned task" }, "create");
    const batch = env.db.batch.bind(env.db);
    let raced = false;
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (
        !raced &&
        statements.some((statement) => statement.sql.includes("INSERT INTO task_schedules"))
      ) {
        raced = true;
        await env.db.run(
          sql("UPDATE runs SET cancel_requested_at=1 WHERE id=:id", { id: claim.run.id }),
        );
      }
      return batch(statements, options);
    });
    await expect(tools.schedule(deadline(task.taskId), "raced_schedule")).rejects.toMatchObject({
      code: "schedule.conflict",
    });
    expect(raced).toBe(true);
    expect(await env.count("task_schedules")).toBe(0);
    expect(await env.count("schedule_audit")).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  });

  it.each(["local", "trigger"] as const)(
    "uses the same create, subtree move and schedule contract in %s",
    async (executor) => {
      const { tools, owner, changed } = await session(executor);
      const created = await tools.create({ title: "Native task" }, "create_1");
      expect(created).toMatchObject({ created: true, collection: "unclassified" });
      expect(await tools.create({ title: "Native task" }, "create_1")).toEqual({
        ...created,
        created: false,
      });
      const child = await tools.create(
        { title: "Native subtask", parentTaskId: created.taskId },
        "create_2",
      );
      const moved = await tools.move({ taskId: created.taskId, collection: "later" }, "move_1");
      expect(new Set(moved.movedTaskIds)).toEqual(new Set([created.taskId, child.taskId]));
      expect(await tools.tasks.getTask(owner, child.taskId)).toMatchObject({
        task: { collection: "later", parentId: created.taskId, source: "simon" },
      });
      const saved = await tools.schedule(deadline(created.taskId), "schedule_1");
      expect(saved).toMatchObject({
        version: 1,
        deadline: { date: "2026-10-01", zone: "Asia/Kathmandu" },
      });
      expect(await tools.schedule(deadline(created.taskId), "schedule_1")).toEqual(saved);
      expect(
        await tools.schedule({ operation: "read", taskId: created.taskId }, "read_1"),
      ).toMatchObject(saved);
      expect(changed).toHaveBeenCalledWith(owner, created.taskId, 1);
      await expect(tools.schedule(deadline(created.taskId), "schedule_2")).rejects.toMatchObject({
        code: "schedule.conflict",
      });
      expect(await env.count("tasks")).toBe(2);
    },
  );

  it("also exposes native task work in task chat, not only quick chat", async () => {
    const { tools } = await session("local", false);
    expect(
      await tools.create({ title: "Another owned task", collection: "now" }, "create"),
    ).toMatchObject({ collection: "now", created: true });
  });

  it("separates call IDs and refuses unsafe identifiers", async () => {
    const { tools } = await session();
    const first = await tools.create({ title: "First" }, "first");
    const second = await tools.create({ title: "Second" }, "second");
    expect(first.taskId).not.toBe(second.taskId);
    expect(() => tools.create({ title: "Bad" }, "../../bad")).toThrow("validation");
    expect(await env.count("tasks")).toBe(2);
  });

  it("rejects another owner's task and parent without changing them", async () => {
    const { tools } = await session();
    const other = await env.createUser();
    const foreign = taskIdSchema.parse(await env.createTask(other));
    await expect(
      tools.create({ title: "Child", parentTaskId: foreign }, "create"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      tools.move({ taskId: foreign, collection: "later" }, "move"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(tools.schedule(deadline(foreign), "schedule")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await env.count("task_schedules")).toBe(0);
    expect(await env.count("tasks")).toBe(1);
  });

  it.each(["cancel", "generation", "paused", "expired", "locked"] as const)(
    "rejects new and replayed effects after %s",
    async (cause) => {
      const { tools, claim, owner } = await session();
      const task = await tools.create({ title: "Before revoke" }, "create");
      await tools.schedule(deadline(task.taskId), "schedule");
      if (cause === "cancel")
        await env.db.run(
          sql("UPDATE runs SET cancel_requested_at=1 WHERE id=:id", { id: claim.run.id }),
        );
      if (cause === "generation")
        await env.db.run(sql("UPDATE executor_state SET generation=generation+1 WHERE id=1"));
      if (cause === "paused")
        await env.db.run(
          sql("UPDATE runs SET status='awaiting_approval' WHERE id=:id", { id: claim.run.id }),
        );
      if (cause === "expired") env.clock += 25 * 3600000;
      if (cause === "locked")
        await env.db.run(sql("UPDATE users SET beta_state='relocked' WHERE id=:owner", { owner }));
      await expect(tools.create({ title: "Before revoke" }, "create")).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(tools.create({ title: "After revoke" }, "new_create")).rejects.toMatchObject({
        code: cause === "locked" ? "access.relocked" : "not_found",
      });
      await expect(
        tools.move({ taskId: task.taskId, collection: "later" }, "move"),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(tools.schedule(deadline(task.taskId), "schedule")).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await env.count("tasks")).toBe(1);
      expect(
        await env.db.first(
          sql("SELECT version FROM task_schedules WHERE task_id=:task", { task: task.taskId }),
        ),
      ).toEqual({ version: 1 });
    },
  );
});
