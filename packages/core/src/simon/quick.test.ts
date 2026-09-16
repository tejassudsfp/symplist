import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { MaintenanceFence } from "../maintenance-fence.ts";
import { TaskService } from "../tasks/service.ts";
import { SimonQuickChats } from "./quick.ts";
import { cleanupQuickChats } from "./quick-delete.ts";
import { SimonRepository } from "./repository.ts";
import { SimonUserAsks } from "./user-asks.ts";

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

describe("quick chat deletion", () => {
  it("deletes question history across a real continuation chain without a foreign-key failure", async () => {
    const accepted = await repo.acceptMessage(owner, conversation, "question", {
      text: "Ask before continuing",
      tier: "fast",
    });
    const first = await repo.claim(String(accepted.runId), "local");
    if (!first) throw new Error("missing claim");
    const asks = new SimonUserAsks(repo);
    try {
      const ask = await asks.pause(
        first.run,
        first.key,
        { toolCallId: "question-one", question: "Private question" },
        { text: "", steps: 1 },
      );
      const next = await asks.decide(owner, ask, { kind: "answer", text: "Private answer" });
      const second = await repo.claim(next, "local");
      if (!second) throw new Error("missing continuation");
      try {
        await asks.pause(
          second.run,
          second.key,
          { toolCallId: "question-two", question: "Another question" },
          { text: "", steps: 1 },
        );
        expect(await env.count("runs")).toBe(2);
        expect(await env.count("user_asks")).toBe(2);
        await new SimonQuickChats(repo).close(owner, conversation);
        expect(await env.count("runs")).toBe(0);
        expect(await env.count("user_asks")).toBe(0);
        expect(await env.count("messages")).toBe(0);
        await expect(asks.load(owner, ask)).rejects.toMatchObject({ code: "not_found" });
      } finally {
        repo.releaseClaim(second);
      }
    } finally {
      repo.releaseClaim(first);
    }
  });

  it("deletes encrypted history and queued work, and fences the still-running executor", async () => {
    const first = await repo.acceptMessage(owner, conversation, "first", {
      text: "Private close marker",
      tier: "fast",
    });
    const claim = await repo.claim(first.runId ?? "", "local");
    if (!claim) throw new Error("Expected claim");
    try {
      await repo.checkpoint(claim.run, claim.key, "Private assistant marker", 1, "running", {
        snapshotJson: JSON.stringify({
          id: claim.run.id,
          role: "assistant",
          parts: [{ type: "text", text: "Private assistant marker" }],
        }),
      });
      await repo.acceptMessage(owner, conversation, "queued", {
        text: "Queued marker",
        tier: "fast",
      });
      expect(await env.count("message_parts")).toBe(1);
      expect(await env.count("messages")).toBe(3);
      expect(await new SimonQuickChats(repo).close(owner, conversation)).toEqual({
        conversationId: conversation,
        runId: claim.run.id,
      });
      for (const table of [
        "conversations",
        "messages",
        "message_parts",
        "runs",
        "approvals",
        "user_asks",
        "tool_invocations",
      ])
        expect(await env.count(table)).toBe(0);
      expect(await repo.mayExecute(claim.run)).toBe(false);
      expect(await repo.checkpoint(claim.run, claim.key, "Late plaintext", 2, "completed")).toBe(
        false,
      );
      expect(
        await env.db.first(
          sql("SELECT status FROM dispatch_intents WHERE subject_id=:run", { run: claim.run.id }),
        ),
      ).toEqual({ status: "cancelled" });
      await expect(repo.history(owner, conversation)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      repo.releaseClaim(claim);
    }
  });

  it.each(["foreign", "task", "locked"] as const)(
    "refuses %s deletion without losing history",
    async (reason) => {
      if (reason === "task") await new SimonQuickChats(repo).save(owner, conversation, input);
      if (reason === "locked")
        await env.db.run(sql("UPDATE users SET beta_state='relocked' WHERE id=:owner", { owner }));
      const actor = reason === "foreign" ? await env.createUser() : owner;
      await expect(new SimonQuickChats(repo).close(actor, conversation)).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await env.count("conversations")).toBe(1);
    },
  );

  it("rolls the whole close back when deleting a child fails", async () => {
    await repo.acceptMessage(owner, conversation, "first", {
      text: "Keep on failure",
      tier: "fast",
    });
    await env.db.executeScript(
      "CREATE TRIGGER reject_message_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'test close refused'); END;",
    );
    await expect(new SimonQuickChats(repo).close(owner, conversation)).rejects.toMatchObject({
      code: "db.statement_failed",
      providerMessage: "test close refused",
    });
    expect(await env.count("conversations")).toBe(1);
    expect(await env.count("messages")).toBe(1);
    expect(await env.db.first(sql("SELECT status FROM dispatch_intents"))).toEqual({
      status: "pending",
    });
  });

  it("expires at most five chats per pass and preserves live and saved chats", async () => {
    for (let index = 0; index < 6; index++) await repo.createConversation(owner, null);
    const saved = await repo.createConversation(owner, null);
    await new SimonQuickChats(repo).save(owner, saved, input);
    env.clock += 25 * 3600000;
    const live = await repo.createConversation(owner, null);
    const fence = new MaintenanceFence(env.db, { executor: "local", generation: 1 });
    expect(await cleanupQuickChats(repo, fence)).toBe(5);
    expect(await cleanupQuickChats(repo, fence)).toBe(2);
    expect(await cleanupQuickChats(repo, fence)).toBe(0);
    expect(
      (await env.db.all(sql("SELECT id FROM conversations ORDER BY id")))
        .map((row) => row.id)
        .sort(),
    ).toEqual([saved, live].sort());
  });

  it("rechecks renewal and executor generation inside the actual expiry transaction", async () => {
    env.clock += 25 * 3600000;
    const batch = env.db.batch.bind(env.db);
    let raced = false;
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (
        !raced &&
        statements.some((statement) => statement.sql.includes("DELETE FROM conversations"))
      ) {
        raced = true;
        await env.db.run(sql("UPDATE executor_state SET generation=generation+1 WHERE id=1"));
      }
      return batch(statements, options);
    });
    expect(
      await cleanupQuickChats(
        repo,
        new MaintenanceFence(env.db, { executor: "local", generation: 1 }),
      ),
    ).toBe(0);
    expect(raced).toBe(true);
    expect(await env.count("conversations")).toBe(1);
    await env.db.run(
      sql("UPDATE conversations SET expires_at=:expiry", { expiry: String(env.clock + 3600000) }),
    );
    expect(
      await cleanupQuickChats(
        repo,
        new MaintenanceFence(env.db, { executor: "local", generation: 2 }),
      ),
    ).toBe(0);
  });
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
