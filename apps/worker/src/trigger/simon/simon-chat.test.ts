import { describe, expect, it } from "vitest";
import { createDocumentsTestEnvironment } from "../../../../../packages/core/src/documents/test-support.ts";
import { runForChat, SIMON_CHAT_IDLE_SECONDS, simonChat } from "./simon-chat.ts";

const uuidv7 = () => crypto.randomUUID().replace(/^(.{14})./, "$17");

async function seed(env: Awaited<ReturnType<typeof createDocumentsTestEnvironment>>) {
  const runId = uuidv7();
  const owner = await env.createUser();
  const task = await env.createTask(owner);
  const chatId = uuidv7();
  await env.db.batch([
    {
      sql: `INSERT INTO conversations (id, owner_id, kind, task_id, next_message_seq, context_epoch,
            created_at, updated_at, write_id) VALUES (?, ?, 'task', ?, 0, 0, ?, ?, ?)`,
      params: [chatId, owner, task, String(env.clock), String(env.clock), crypto.randomUUID()],
    },
    {
      sql: `INSERT INTO runs (id, conversation_id, owner_id, task_id, kind, status, executor,
            executor_generation, tier, created_at, write_id)
            VALUES (?, ?, ?, ?, 'turn', 'queued', 'trigger', 1, 'fast', ?, ?)`,
      params: [runId, chatId, owner, task, String(env.clock), crypto.randomUUID()],
    },
  ]);
  return { owner, chatId, runId };
}

describe("simon-chat session", () => {
  it("is keyed on the Symplist conversation, with a bounded warm window", () => {
    expect(simonChat.id).toBe("simon-chat");
    expect(SIMON_CHAT_IDLE_SECONDS).toBeGreaterThan(0);
    expect(SIMON_CHAT_IDLE_SECONDS).toBeLessThanOrEqual(300);
  });

  it("finds the conversation's own live run, with no caller able to name one", async () => {
    const env = await createDocumentsTestEnvironment();
    try {
      const { chatId, runId } = await seed(env);
      const runtime = { db: env.db } as never;
      await expect(runForChat(runtime, chatId)).resolves.toBe(runId);
    } finally {
      await env.close();
    }
  });

  it("never reaches another conversation's run", async () => {
    const env = await createDocumentsTestEnvironment();
    try {
      const first = await seed(env);
      const second = await seed(env);
      // Each session resolves only its own conversation's run; there is no argument that could
      // point this turn at the other one.
      await expect(runForChat({ db: env.db } as never, first.chatId)).resolves.toBe(first.runId);
      await expect(runForChat({ db: env.db } as never, second.chatId)).resolves.toBe(second.runId);
    } finally {
      await env.close();
    }
  });

  it("refuses a chat with no live run, and one that is not a conversation at all", async () => {
    const env = await createDocumentsTestEnvironment();
    try {
      const { chatId, runId } = await seed(env);
      await env.db.run({ sql: "UPDATE runs SET status='completed' WHERE id=?", params: [runId] });
      await expect(runForChat({ db: env.db } as never, chatId)).rejects.toMatchObject({
        code: "simon.not_found",
      });
      await expect(runForChat({ db: env.db } as never, uuidv7())).rejects.toMatchObject({
        code: "simon.not_found",
      });
    } finally {
      await env.close();
    }
  });
});
