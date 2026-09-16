import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { SimonNativeSession } from "./native.ts";
import { SimonQuickChats } from "./quick.ts";
import { SimonRepository } from "./repository.ts";
import type { ClaimedSimonRun } from "./types.ts";

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
    const batch = env.db.batch.bind(env.db);
    let raced = false;
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (!raced && statements.some((statement) => statement.sql.includes("INSERT INTO tasks"))) {
        raced = true;
        env.clock += 25 * 3_600_000;
      }
      return batch(statements, options);
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
    const batch = env.db.batch.bind(env.db);
    let raced = false;
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (!raced && statements.some((statement) => statement.sql.includes("INSERT INTO tasks"))) {
        raced = true;
        env.clock += 25 * 3_600_000;
      }
      return batch(statements, options);
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
    ).rejects.toMatchObject({ code: "schedule.conflict" });
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
});
