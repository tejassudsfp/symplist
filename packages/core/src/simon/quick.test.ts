import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { TaskService } from "../tasks/service.ts";
import { SimonQuickChats } from "./quick.ts";
import { SimonRepository } from "./repository.ts";

let env: DocumentsTestEnvironment;
let repo: SimonRepository;
let owner: string;
let conversation: string;
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  await env.db.run(sql("UPDATE executor_state SET mode='local' WHERE id=1"));
  repo = new SimonRepository({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: 24,
  });
  owner = await env.createUser();
  conversation = await repo.createConversation(owner, null);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.close();
});
const input = { title: "Saved workspace help", collection: "later" as const };

describe("quick chat atomic save", () => {
  it("creates a normal task and keeps the conversation and encrypted history", async () => {
    const accepted = await repo.acceptMessage(owner, conversation, "message", {
      text: "A private question",
      tier: "fast",
    });
    const claim = await repo.claim(accepted.runId ?? "", "local");
    if (!claim) throw new Error("Expected run");
    try {
      expect(await repo.checkpoint(claim.run, claim.key, "A private answer", 1, "completed")).toBe(
        true,
      );
    } finally {
      repo.releaseClaim(claim);
    }
    const saved = vi.fn(async () => {});
    const result = await new SimonQuickChats(repo, saved).save(owner, conversation, input);
    expect(result).toEqual({
      conversationId: conversation,
      taskId: conversation,
      collection: "later",
    });
    expect(await new TaskService(repo.options).getTask(owner, result.taskId)).toMatchObject({
      task: { title: input.title, collection: "later", source: "user" },
    });
    expect(
      await env.db.first(
        sql("SELECT kind,task_id,expires_at,context_epoch FROM conversations WHERE id=:id", {
          id: conversation,
        }),
      ),
    ).toEqual({ kind: "task", task_id: result.taskId, expires_at: null, context_epoch: 1 });
    expect(
      await env.db.first(
        sql("SELECT task_id FROM runs WHERE id=:id", { id: accepted.runId ?? "" }),
      ),
    ).toEqual({ task_id: result.taskId });
    expect(await env.count("messages")).toBe(2);
    const history = await repo.history(owner, conversation);
    expect(JSON.stringify(history)).toContain("A private question");
    expect(JSON.stringify(history)).toContain("A private answer");
    expect(JSON.stringify(await env.db.all(sql("SELECT * FROM messages")))).not.toContain(
      "A private",
    );
    expect(saved).toHaveBeenCalledExactlyOnceWith(owner, "later", expect.any(String));
  });

  it.each(["foreign", "expired", "active", "locked"] as const)(
    "never creates an orphan task for a %s chat",
    async (reason) => {
      if (reason === "expired") env.clock += 25 * 3600000;
      if (reason === "active")
        await repo.acceptMessage(owner, conversation, "busy", { text: "Working", tier: "fast" });
      if (reason === "locked")
        await env.db.run(sql("UPDATE users SET beta_state='relocked' WHERE id=:owner", { owner }));
      const actor = reason === "foreign" ? await env.createUser() : owner;
      await expect(
        new SimonQuickChats(repo).save(actor, conversation, input),
      ).rejects.toMatchObject({ code: reason === "locked" ? "access.relocked" : "not_found" });
      expect(await env.count("tasks")).toBe(0);
      expect(
        await env.db.first(
          sql("SELECT kind,task_id FROM conversations WHERE id=:id", { id: conversation }),
        ),
      ).toEqual({ kind: "quick", task_id: null });
    },
  );

  it("refuses when another message claims the chat after task planning", async () => {
    const batch = env.db.batch.bind(env.db);
    let raced = false;
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (!raced && statements.some((statement) => statement.sql.includes("INSERT INTO tasks"))) {
        raced = true;
        await repo.acceptMessage(owner, conversation, "race", { text: "New work", tier: "fast" });
      }
      return batch(statements, options);
    });
    await expect(new SimonQuickChats(repo).save(owner, conversation, input)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(raced).toBe(true);
    expect(await env.count("tasks")).toBe(0);
    expect(await env.count("messages")).toBe(1);
  });

  it("rolls back task creation when attaching the conversation fails", async () => {
    await env.db.executeScript(
      "CREATE TRIGGER reject_quick_attach BEFORE UPDATE OF kind ON conversations BEGIN SELECT RAISE(ABORT, 'test attachment refused'); END;",
    );
    await expect(new SimonQuickChats(repo).save(owner, conversation, input)).rejects.toThrow();
    expect(await env.count("tasks")).toBe(0);
    expect(
      await env.db.first(sql("SELECT kind FROM conversations WHERE id=:id", { id: conversation })),
    ).toEqual({ kind: "quick" });
  });
});
