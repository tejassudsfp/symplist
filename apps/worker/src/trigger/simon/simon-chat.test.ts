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

  it("runs only a run that already belongs to this chat", async () => {
    const env = await createDocumentsTestEnvironment();
    try {
      const { chatId, runId } = await seed(env);
      const runtime = { db: env.db } as never;
      await expect(runForChat(runtime, chatId, { runId })).resolves.toBe(runId);
    } finally {
      await env.close();
    }
  });

  it("refuses a run from another conversation, so client data cannot select one", async () => {
    const env = await createDocumentsTestEnvironment();
    try {
      const first = await seed(env);
      const second = await seed(env);
      const runtime = { db: env.db } as never;
      // `claim` fences on owner, executor and generation but is reached by run id alone. A session
      // is addressed by chat id, so a run belonging to a different conversation must not start here
      // even when it is perfectly valid on its own.
      await expect(
        runForChat(runtime, second.chatId, { runId: first.runId }),
      ).rejects.toMatchObject({
        code: "simon.not_found",
      });
      expect(first.chatId).not.toBe(second.chatId);
    } finally {
      await env.close();
    }
  });

  it("refuses client data that is absent, malformed or not a run id", async () => {
    const env = await createDocumentsTestEnvironment();
    try {
      const { chatId } = await seed(env);
      const runtime = { db: env.db } as never;
      for (const clientData of [
        undefined,
        {},
        { runId: 42 },
        { runId: "../../etc" },
        { runId: "" },
      ])
        await expect(runForChat(runtime, chatId, clientData)).rejects.toMatchObject({
          code: "simon.payload_invalid",
        });
    } finally {
      await env.close();
    }
  });
});
