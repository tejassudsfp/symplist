import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
  GIT_TEST_TIMEOUT_MS,
} from "../documents/test-support.ts";
import { SimonTranscriptStorage, transcriptMessageContext } from "./transcript-storage.ts";

let env: DocumentsTestEnvironment;
let owner: string;
let storage: SimonTranscriptStorage;
let chatId: string;

/** A conversation row to hang the transcript off, as the foreign key requires. */
async function createConversation(ownerId: string, taskId: string): Promise<string> {
  const id = crypto.randomUUID().replace(/^(.{14})./, "$17");
  await env.db.batch([
    {
      sql: `INSERT INTO conversations (id, owner_id, kind, task_id, next_message_seq, context_epoch,
            created_at, updated_at, write_id) VALUES (?, ?, 'task', ?, 0, 0, ?, ?, ?)`,
      params: [id, ownerId, taskId, String(env.clock), String(env.clock), crypto.randomUUID()],
    },
  ]);
  return id;
}

const message = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  parts: [{ type: "text" as const, text, state: "done" as const }],
});

beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  owner = await env.createUser();
  const task = await env.createTask(owner);
  chatId = await createConversation(owner, task);
  storage = new SimonTranscriptStorage({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
  });
});
afterEach(async () => {
  await env.close();
});

describe("durable chat transcript storage", { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it("returns an empty transcript before anything is written", async () => {
    await expect(storage.load(owner, chatId)).resolves.toEqual({ messages: [], state: null });
  });

  it("appends in order, replaces a known id in place, and round-trips the message", async () => {
    await storage.save(owner, chatId, {
      changes: [
        { op: "put", message: message("m1", "first") },
        { op: "put", message: message("m2", "second") },
      ],
    });
    // Replacing m1 must not move it to the end: a settled partial keeps its place.
    await storage.save(owner, chatId, {
      changes: [{ op: "put", message: message("m1", "first (edited)") }],
    });
    const loaded = await storage.load(owner, chatId);
    expect(loaded.messages.map((m) => (m as { id: string }).id)).toEqual(["m1", "m2"]);
    expect(loaded.messages[0]).toMatchObject({
      parts: [{ type: "text", text: "first (edited)" }],
    });
  });

  it("keeps a partial answer marked until it is saved final", async () => {
    await storage.save(owner, chatId, {
      changes: [{ op: "put", message: message("m1", "half"), final: false }],
    });
    await expect(storage.load(owner, chatId)).resolves.toMatchObject({ nonFinalIds: ["m1"] });
    await storage.save(owner, chatId, {
      changes: [{ op: "put", message: message("m1", "whole"), final: true }],
    });
    expect((await storage.load(owner, chatId)).nonFinalIds).toBeUndefined();
  });

  it("removes by id and truncates after an anchor, ignoring unknown ids", async () => {
    await storage.save(owner, chatId, {
      changes: ["m1", "m2", "m3", "m4"].map((id) => ({
        op: "put" as const,
        message: message(id, id),
      })),
    });
    await storage.save(owner, chatId, {
      changes: [
        { op: "remove", id: "m2" },
        { op: "remove", id: "nope" },
        { op: "truncateAfter", afterId: "m3" },
        { op: "truncateAfter", afterId: "unknown" },
      ],
    });
    const loaded = await storage.load(owner, chatId);
    expect(loaded.messages.map((m) => (m as { id: string }).id)).toEqual(["m1", "m3"]);
  });

  it("round-trips the opaque state record and keeps it when a changeset does not mention it", async () => {
    await storage.save(owner, chatId, {
      changes: [{ op: "state", value: { summary: "compacted", watermark: 7 } }],
    });
    await expect(storage.load(owner, chatId)).resolves.toMatchObject({
      state: { summary: "compacted", watermark: 7 },
    });
    await storage.save(owner, chatId, { changes: [{ op: "put", message: message("m1", "x") }] });
    expect((await storage.load(owner, chatId)).state).toEqual({
      summary: "compacted",
      watermark: 7,
    });
    await storage.save(owner, chatId, { changes: [{ op: "state", value: null }] });
    expect((await storage.load(owner, chatId)).state).toBeNull();
  });

  it("persists both cursors and keeps the one a changeset omits", async () => {
    await storage.save(owner, chatId, {
      changes: [],
      cursors: { lastOutEventId: "out-1", lastInEventId: "in-1" },
    });
    await storage.save(owner, chatId, { changes: [], cursors: { lastOutEventId: "out-2" } });
    await expect(storage.load(owner, chatId)).resolves.toMatchObject({
      cursors: { lastOutEventId: "out-2", lastInEventId: "in-1" },
    });
  });

  it("pages backwards from a cursor and refuses one it never issued", async () => {
    await storage.save(owner, chatId, {
      changes: ["m1", "m2", "m3"].map((id) => ({ op: "put" as const, message: message(id, id) })),
    });
    const page = await storage.load(owner, chatId, { limit: 2 });
    expect(page.messages.map((m) => (m as { id: string }).id)).toEqual(["m2", "m3"]);
    expect(page.nextCursor).toBe("m2");
    const older = await storage.load(owner, chatId, { limit: 2, before: page.nextCursor });
    expect(older.messages.map((m) => (m as { id: string }).id)).toEqual(["m1"]);
    expect(older.nextCursor).toBeUndefined();
    await expect(storage.load(owner, chatId, { before: "never-issued" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("applies the same changeset twice without duplicating or reordering", async () => {
    const changeset = {
      changes: [
        { op: "put" as const, message: message("m1", "a") },
        { op: "put" as const, message: message("m2", "b") },
      ],
    };
    await storage.save(owner, chatId, changeset);
    await storage.save(owner, chatId, changeset);
    const loaded = await storage.load(owner, chatId);
    expect(loaded.messages.map((m) => (m as { id: string }).id)).toEqual(["m1", "m2"]);
  });

  it("isolates one owner's transcript from another's", async () => {
    const other = await env.createUser();
    const otherTask = await env.createTask(other);
    const otherChat = await createConversation(other, otherTask);
    await storage.save(owner, chatId, { changes: [{ op: "put", message: message("m1", "mine") }] });
    await storage.save(other, otherChat, {
      changes: [{ op: "put", message: message("m1", "theirs") }],
    });
    // The same chat id read as the wrong owner returns nothing, not the other transcript.
    await expect(storage.load(other, chatId)).resolves.toEqual({ messages: [], state: null });
    expect((await storage.load(other, otherChat)).messages[0]).toMatchObject({
      parts: [{ type: "text", text: "theirs" }],
    });
  });

  it("stores the message encrypted, bound to its owner, chat and id", async () => {
    await storage.save(owner, chatId, {
      changes: [{ op: "put", message: message("m1", "a private marker") }],
    });
    const row = await env.db.first({
      sql: "SELECT message_enc FROM chat_transcript_messages WHERE chat_id = ? AND message_id = ?",
      params: [chatId, "m1"],
    });
    const envelope = String(row?.message_enc);
    expect(envelope).toMatch(/^sym1\./);
    expect(envelope).not.toContain("a private marker");
    // The binding is part of the ciphertext: the same envelope under another id must not open.
    const { decryptFieldText } = await import("@symplist/crypto");
    const { AccountKeyStore } = await import("../account/keys.ts");
    const key = await new AccountKeyStore({ db: env.db, keys: env.keys }).require(owner);
    expect(() =>
      decryptFieldText(key, transcriptMessageContext(owner, chatId, "m2"), envelope),
    ).toThrow();
  });

  it("deletes every row of an owner for account purge", async () => {
    await storage.save(owner, chatId, {
      changes: [
        { op: "put", message: message("m1", "x") },
        { op: "state", value: { a: 1 } },
      ],
    });
    await env.db.batch([...SimonTranscriptStorage.purgeStatements(owner)]);
    await expect(
      env.db.first({
        sql: "SELECT COUNT(*) AS n FROM chat_transcript_messages WHERE owner_id = ?",
        params: [owner],
      }),
    ).resolves.toEqual({ n: 0 });
    await expect(
      env.db.first({
        sql: "SELECT COUNT(*) AS n FROM chat_transcript_state WHERE owner_id = ?",
        params: [owner],
      }),
    ).resolves.toEqual({ n: 0 });
  });
});
