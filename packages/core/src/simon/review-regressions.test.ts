import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { IdempotencyStore } from "../idempotency/store.ts";
import { TaskTreeLoader } from "../tasks/state.ts";
import type { SimonWriteFold } from "./fold.ts";
import { SimonNativeSession } from "./native.ts";
import { SimonQuickChats } from "./quick.ts";
import { SimonRepository } from "./repository.ts";
import { type ClaimedSimonRun, SimonError } from "./types.ts";

let env: DocumentsTestEnvironment;
let repository: SimonRepository;
let owner: string;
let conversation: string;
const claims: ClaimedSimonRun[] = [];
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  await env.db.run(sql("UPDATE executor_state SET mode='local'"));
  repository = new SimonRepository({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: 24,
  });
  owner = await env.createUser();
  conversation = await repository.createConversation(owner, null);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const claim of claims.splice(0)) repository.releaseClaim(claim);
  await env.close();
});
async function native() {
  const accepted = await repository.acceptMessage(owner, conversation, "review-message", {
    text: "Review",
    tier: "fast",
  });
  const claim = await repository.claim(accepted.runId ?? "", "local");
  if (!claim) throw new Error("Missing claim");
  claims.push(claim);
  return new SimonNativeSession(repository, claim, {
    scheduling: { remindersEnabled: true, emailEnabled: false, defaultZone: "UTC" },
  });
}

describe("adversarial Simon regressions (expected behavior)", () => {
  it("does not save an expired quick chat when expiry crosses during task planning", async () => {
    const load = TaskTreeLoader.prototype.load;
    let raced = false;
    vi.spyOn(TaskTreeLoader.prototype, "load").mockImplementation(async function (
      this: TaskTreeLoader,
      ...args
    ) {
      const result = await load.apply(this, args);
      if (!raced) {
        raced = true;
        env.clock += 25 * 3_600_000;
      }
      return result;
    });
    await expect(
      new SimonQuickChats(repository).save(owner, conversation, {
        title: "Expired",
        collection: "later",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(raced).toBe(true);
    expect(await env.count("tasks")).toBe(0);
  });

  it("does not commit a native task after its quick conversation expires during planning", async () => {
    const tools = await native();
    const load = TaskTreeLoader.prototype.load;
    let raced = false;
    vi.spyOn(TaskTreeLoader.prototype, "load").mockImplementation(async function (
      this: TaskTreeLoader,
      ...args
    ) {
      const result = await load.apply(this, args);
      if (!raced) {
        raced = true;
        env.clock += 25 * 3_600_000;
      }
      return result;
    });
    await expect(tools.create({ title: "Expired native" }, "create")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(raced).toBe(true);
    expect(await env.count("tasks")).toBe(0);
  });

  it("does not commit a schedule after expiry crosses during its preliminary read", async () => {
    const tools = await native();
    const task = await tools.create({ title: "Schedule target" }, "create");
    const get = tools.schedules.get.bind(tools.schedules);
    vi.spyOn(tools.schedules, "get").mockImplementation(async (...args) => {
      const result = await get(...args);
      env.clock += 25 * 3_600_000;
      return result;
    });
    await expect(
      tools.schedule(
        {
          operation: "set_deadline",
          taskId: task.taskId,
          expectedVersion: 0,
          deadline: { kind: "date", date: "2026-10-01", zone: "UTC" },
        },
        "schedule",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await env.count("task_schedules")).toBe(0);
  });

  it("does not reapply a replayed move over an intervening owner move", async () => {
    const tools = await native();
    const task = await tools.create({ title: "Move target" }, "create");
    const args = { taskId: task.taskId, collection: "later" as const };
    await tools.move(args, "move_once");
    await tools.tasks.move({
      ownerId: owner,
      actor: { kind: "user" },
      taskId: task.taskId,
      collection: "now",
      parentId: null,
    });
    await tools.move(args, "move_once");
    expect((await tools.tasks.getTask(owner, task.taskId)).task.collection).toBe("now");
  });

  it.each(["create", "move"] as const)(
    "binds %s replay to the exact arguments and tool identity",
    async (operation) => {
      const tools = await native();
      const target = await tools.create({ title: "Original private title" }, "original");
      if (operation === "create") {
        await expect(
          tools.create({ title: "Changed arguments" }, "original"),
        ).rejects.toMatchObject({ code: "idempotency.mismatch" });
        await expect(
          tools.move({ taskId: target.taskId, collection: "later" }, "original"),
        ).rejects.toMatchObject({ code: "idempotency.mismatch" });
      } else {
        await tools.move({ taskId: target.taskId, collection: "later" }, "move");
        await expect(
          tools.move({ taskId: target.taskId, collection: "now" }, "move"),
        ).rejects.toMatchObject({ code: "idempotency.mismatch" });
        expect((await tools.tasks.getTask(owner, target.taskId)).task.collection).toBe("later");
      }
      expect(await env.count("tasks")).toBe(1);
      const rows = await env.db.all(
        sql("SELECT * FROM idempotency_records WHERE scope='simon.native.task'"),
      );
      expect(JSON.stringify(rows)).not.toContain("Original private title");
      expect(
        rows.every(
          (row) => row.status === "completed" && String(row.response_enc).startsWith("sym1."),
        ),
      ).toBe(true);
    },
  );

  it("replays from durable encrypted state after constructing a fresh native session", async () => {
    const tools = await native();
    const target = await tools.create({ title: "Durable replay" }, "create");
    const args = { taskId: target.taskId, collection: "later" as const };
    const result = await tools.move(args, "move");
    await tools.tasks.move({
      ownerId: owner,
      actor: { kind: "user" },
      taskId: target.taskId,
      collection: "now",
    });
    const fresh = new SimonNativeSession(repository, tools.claim, tools.options);
    expect(await fresh.move(args, "move")).toEqual(result);
    expect(await fresh.create({ title: "Durable replay" }, "create")).toEqual({
      ...target,
      created: false,
    });
    expect((await fresh.tasks.getTask(owner, target.taskId)).task.collection).toBe("now");
    expect(await env.count("tasks")).toBe(1);
  });

  it("records even a collection no-op once without reordering or incrementing the task version", async () => {
    const tools = await native();
    const first = await tools.create({ title: "First", collection: "now" }, "first");
    await tools.create({ title: "Second", collection: "now" }, "second");
    const before = (await tools.tasks.getTask(owner, first.taskId)).task;
    const args = { taskId: first.taskId, collection: "now" as const };
    const result = await tools.move(args, "no_op");
    expect((await tools.tasks.getTask(owner, first.taskId)).task).toEqual(before);
    await tools.tasks.move({
      ownerId: owner,
      actor: { kind: "user" },
      taskId: first.taskId,
      collection: "later",
    });
    expect(await tools.move(args, "no_op")).toEqual(result);
    expect((await tools.tasks.getTask(owner, first.taskId)).task.collection).toBe("later");
  });

  it("folds concurrent duplicate task creation and movement into one effect", async () => {
    const tools = await native();
    const made = await Promise.all([
      tools.create({ title: "Once" }, "once"),
      tools.create({ title: "Once" }, "once"),
    ]);
    expect(new Set(made.map((item) => item.taskId)).size).toBe(1);
    expect(made.filter((item) => item.created)).toHaveLength(1);
    const taskId = made[0]?.taskId;
    if (!taskId) throw new Error("Missing task");
    const before = (await tools.tasks.getTask(owner, taskId)).task.version;
    const moved = await Promise.all([
      tools.move({ taskId, collection: "later" }, "move"),
      tools.move({ taskId, collection: "later" }, "move"),
    ]);
    expect(moved[0]).toEqual(moved[1]);
    expect((await tools.tasks.getTask(owner, taskId)).task.version).toBe(before + 1);
    expect(await env.count("idempotency_records")).toBe(2);
  });

  it("replans a first-time no-op if an owner move wins its deciding transaction", async () => {
    const tools = await native();
    const target = await tools.create({ title: "Race target", collection: "now" }, "create");
    const batch = env.db.batch.bind(env.db);
    let raced = false;
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (
        !raced &&
        statements.some((statement) =>
          statement.sql.startsWith("UPDATE users SET task_tree_write_id"),
        )
      ) {
        raced = true;
        await tools.tasks.move({
          ownerId: owner,
          actor: { kind: "user" },
          taskId: target.taskId,
          collection: "later",
        });
      }
      return batch(statements, options);
    });
    await tools.move({ taskId: target.taskId, collection: "now" }, "move");
    expect(raced).toBe(true);
    expect((await tools.tasks.getTask(owner, target.taskId)).task.collection).toBe("now");
    expect(await env.count("idempotency_records")).toBe(2);
  });

  it("retains native receipts past the HTTP replay window and deletes them on quick close", async () => {
    const tools = await native();
    const task = await tools.create({ title: "Long-lived effect" }, "create");
    const input = { taskId: task.taskId, collection: "later" as const };
    const first = await tools.move(input, "move");
    env.clock += 23 * 3_600_000;
    await repository.acceptMessage(owner, conversation, "followup", {
      text: "More workspace help",
      tier: "fast",
    });
    env.clock += 2 * 3_600_000;
    await tools.tasks.move({
      ownerId: owner,
      actor: { kind: "user" },
      taskId: task.taskId,
      collection: "now",
    });
    expect(await tools.move(input, "move")).toEqual(first);
    expect((await tools.tasks.getTask(owner, task.taskId)).task.collection).toBe("now");
    const receipts = await env.db.all(sql("SELECT expires_at FROM idempotency_records"));
    expect(receipts).toHaveLength(2);
    expect(receipts.every((row) => row.expires_at === Number.MAX_SAFE_INTEGER)).toBe(true);
    await new SimonQuickChats(repository).close(owner, conversation);
    expect(await env.count("idempotency_records")).toBe(0);
    expect(await env.count("runs")).toBe(0);
    expect(await env.count("tasks")).toBe(1);
  });

  it("deletes only native receipts and preserves the owner's exact HTTP close replay", async () => {
    const tools = await native();
    await tools.create({ title: "Retained task" }, "create");
    const store = new IdempotencyStore(repository.options);
    const request = {
      scope: "DELETE /v1/conversations/:id",
      userId: owner,
      key: "owner-close-key",
      input: { conversationId: conversation },
      now: env.clock,
    };
    const close = () => {
      const folded = store.foldedClaim(request);
      const fold: SimonWriteFold = {
        ...folded,
        completion: (response, accountKey) =>
          store.completeStatement({ claim: folded.claim, response, accountKey, now: env.clock }),
        decide: (results, accountKey, offset) => {
          const decision = store.decideFoldedClaim({
            request,
            folded,
            results,
            accountKey,
            offset,
          });
          if (decision.kind === "mismatch") throw new SimonError("idempotency.mismatch");
          if (decision.kind === "in_progress") throw new SimonError("idempotency.in_progress");
          return decision.kind === "replay"
            ? { kind: "replay", body: decision.response.body }
            : decision;
        },
      };
      return new SimonQuickChats(repository).close(owner, conversation, fold);
    };
    const first = await close();
    expect(first.runId).toBe(tools.claim.run.id);
    expect(await close()).toEqual(first);
    expect(await env.db.all(sql("SELECT scope,status FROM idempotency_records"))).toEqual([
      { scope: request.scope, status: "completed" },
    ]);
    expect(await env.count("runs")).toBe(0);
  });

  it.each(["create", "move"] as const)(
    "freshly rejects %s replay if quick expiry crosses during its tree read",
    async (operation) => {
      const tools = await native();
      const input = { title: "Replay before expiry" };
      const target = await tools.create(input, "create");
      const args = { taskId: target.taskId, collection: "later" as const };
      await tools.move(args, "move");
      const load = TaskTreeLoader.prototype.load;
      vi.spyOn(TaskTreeLoader.prototype, "load").mockImplementation(async function (
        this: TaskTreeLoader,
        ...parameters
      ) {
        const result = await load.apply(this, parameters);
        env.clock += 25 * 3_600_000;
        return result;
      });
      await expect(
        operation === "create" ? tools.create(input, "create") : tools.move(args, "move"),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await env.count("tasks")).toBe(1);
      expect(await env.count("idempotency_records")).toBe(2);
    },
  );
});
