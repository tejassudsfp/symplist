import { SimonTranscriptStorage } from "@symplist/core/simon";
import { describe, expect, it } from "vitest";
import { createDocumentsTestEnvironment } from "../../../../../packages/core/src/documents/test-support.ts";
import { conversationOwner, createTranscriptStorage } from "./transcript-adapter.ts";

async function conversation(
  env: Awaited<ReturnType<typeof createDocumentsTestEnvironment>>,
  owner: string,
) {
  const task = await env.createTask(owner);
  const id = crypto.randomUUID().replace(/^(.{14})./, "$17");
  await env.db.batch([
    {
      sql: `INSERT INTO conversations (id, owner_id, kind, task_id, next_message_seq, context_epoch,
            created_at, updated_at, write_id) VALUES (?, ?, 'task', ?, 0, 0, ?, ?, ?)`,
      params: [id, owner, task, String(env.clock), String(env.clock), crypto.randomUUID()],
    },
  ]);
  return id;
}

describe("chat transcript storage adapter", () => {
  it("resolves the owner from D1, never from the caller", async () => {
    const env = await createDocumentsTestEnvironment();
    try {
      const owner = await env.createUser();
      const chatId = await conversation(env, owner);
      await expect(conversationOwner(env.db, chatId)).resolves.toBe(owner);

      const storage = createTranscriptStorage(
        env.db,
        new SimonTranscriptStorage({ db: env.db, keys: env.keys, now: () => env.clock }),
      );
      await storage.save(
        { chatId },
        {
          changes: [{ op: "put", message: { id: "m1", role: "assistant", parts: [] } }],
        },
      );
      const loaded = await storage.load({ chatId });
      expect((loaded as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(["m1"]);
    } finally {
      await env.close();
    }
  });

  it("refuses a chat id that has no conversation, for reads and writes alike", async () => {
    const env = await createDocumentsTestEnvironment();
    try {
      const storage = createTranscriptStorage(
        env.db,
        new SimonTranscriptStorage({ db: env.db, keys: env.keys, now: () => env.clock }),
      );
      const unknown = "01999999-0000-7000-8000-000000000999";
      await expect(storage.load({ chatId: unknown })).rejects.toMatchObject({
        code: "simon.not_found",
      });
      // A write must fail too: an unknown id is not an invitation to create a transcript.
      await expect(storage.save({ chatId: unknown }, { changes: [] })).rejects.toMatchObject({
        code: "simon.not_found",
      });
      await expect(conversationOwner(env.db, "")).rejects.toMatchObject({
        code: "simon.payload_invalid",
      });
    } finally {
      await env.close();
    }
  });
});
