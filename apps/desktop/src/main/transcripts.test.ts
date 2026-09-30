import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptStore, transcriptAppendOnlyTables } from "./transcripts.ts";

/*
 * The transcript store is the only durable record of a conversation: ACP has no transcript replay, note 18
 * forbids the cloud ever holding one again, and the harness forgets. So the properties worth pinning are
 * that a stored update comes back byte-identical, that a page cursor walks the whole history exactly once,
 * and that nothing can rewrite a row after the fact.
 *
 * `node:sqlite` is used directly in one test to confirm what is on disk, because the interesting claim is
 * about the file rather than about this class.
 */
const directories: string[] = [];
const stores: TranscriptStore[] = [];

function store(options: { readonly now?: () => number; readonly pageSize?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "symplist-transcripts-"));
  directories.push(directory);
  const path = join(directory, "transcripts.sqlite");
  const created = new TranscriptStore({ path, ...options });
  stores.push(created);
  return { created, path };
}

afterEach(() => {
  for (const open of stores.splice(0)) open.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const update = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  messageId: "m1",
  content: { type: "text", text },
});

describe("conversations", () => {
  it("records a conversation with the directory its session is pinned to", async () => {
    const { created } = store();
    const conversation = await created.upsertConversation({
      conversationId: "c1",
      taskId: "task-1",
      cwd: "/Users/someone/projects/symplist",
      acpSessionId: "acp-1",
    });
    expect(conversation).toMatchObject({
      conversationId: "c1",
      taskId: "task-1",
      cwd: "/Users/someone/projects/symplist",
      acpSessionId: "acp-1",
      title: null,
    });
  });

  it("keeps the directory when the conversation is opened again", async () => {
    // An ACP session pins one absolute workspace and cannot be given a second, so a conversation's
    // directory is part of its identity. Letting a later open rewrite it would describe a session that
    // never existed.
    const { created } = store();
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/first" });
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/second" });
    expect((await created.conversation("c1"))?.cwd).toBe("/first");
  });

  it("replaces the harness session id when a session could not be resumed", async () => {
    const { created } = store();
    await created.upsertConversation({
      conversationId: "c1",
      taskId: null,
      cwd: "/repo",
      acpSessionId: "gone",
    });
    await created.setAcpSession("c1", "fresh");
    expect((await created.conversation("c1"))?.acpSessionId).toBe("fresh");
    await created.setAcpSession("c1", null);
    expect((await created.conversation("c1"))?.acpSessionId).toBeNull();
  });

  it("lists conversations newest first and finds the one a task already has", async () => {
    let clock = 1_000;
    const { created } = store({ now: () => (clock += 1_000) });
    await created.upsertConversation({ conversationId: "c1", taskId: "task-1", cwd: "/a" });
    await created.upsertConversation({ conversationId: "c2", taskId: "task-2", cwd: "/b" });
    expect((await created.conversations()).map((row) => row.conversationId)).toEqual(["c2", "c1"]);
    expect((await created.conversationForTask("task-1"))?.conversationId).toBe("c1");
    expect(await created.conversationForTask("task-9")).toBeNull();
  });

  it("names a conversation and lets the name be taken away again", async () => {
    const { created } = store();
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
    await created.setTitle("c1", "Fixing the build");
    expect((await created.conversation("c1"))?.title).toBe("Fixing the build");
    await created.setTitle("c1", null);
    expect((await created.conversation("c1"))?.title).toBeNull();
  });
});

describe("updates", () => {
  it("stores the wire format unchanged, so the renderer folds exactly what arrived", async () => {
    const { created } = store();
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
    const raw = {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "bash",
      kind: "other",
      rawInput: { command: "pnpm lint" },
      _meta: { dsh: { attempt: 1 } },
    };
    await created.appendUpdates("c1", [raw]);
    const page = await created.history("c1", null);
    expect(page.updates).toEqual([{ seq: 1, receivedAt: expect.any(Number), update: raw }]);
  });

  it("numbers updates in arrival order and carries on after a restart", async () => {
    const { created, path } = store();
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
    await created.appendUpdates("c1", [update("one"), update("two")]);
    created.close();
    stores.splice(stores.indexOf(created), 1);
    const reopened = new TranscriptStore({ path });
    stores.push(reopened);
    await reopened.appendUpdates("c1", [update("three")]);
    const page = await reopened.history("c1", null);
    expect(page.updates.map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it("walks the whole history with the cursor, exactly once", async () => {
    const { created } = store({ pageSize: 2 });
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
    await created.appendUpdates(
      "c1",
      ["a", "b", "c", "d", "e"].map((text) => update(text)),
    );
    const seen: number[] = [];
    let cursor: number | null = null;
    for (let page = 0; page < 10; page++) {
      const answer = await created.history("c1", cursor);
      seen.unshift(...answer.updates.map((row) => row.seq));
      cursor = answer.nextBeforeSeq;
      if (cursor === null) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("says a short newest page is the whole history rather than offering an empty older one", async () => {
    const { created } = store({ pageSize: 5 });
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
    await created.appendUpdates("c1", [update("only")]);
    expect(await created.history("c1", null)).toMatchObject({ nextBeforeSeq: null });
  });

  it("returns an unreadable row as null rather than making the conversation unopenable", async () => {
    // A single corrupt row must not cost the whole transcript; the projection already ignores an update
    // it does not recognise, so null lands exactly where it belongs.
    const { created, path } = store();
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
    await created.appendUpdates("c1", [update("fine")]);
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        `INSERT INTO transcript_updates (id, conversation_id, seq, received_at, update_json)
       VALUES ('c1:2', 'c1', 2, 0, 'not json')`,
      )
      .run();
    raw.close();
    const page = await created.history("c1", null);
    expect(page.updates.map((row) => row.update)).toEqual([update("fine"), null]);
  });

  it("refuses to rewrite or delete a stored update", async () => {
    // Transcripts are permanent (note 18). The authorizer is what makes that true of the file rather than
    // only of our habits, so the refusal is asserted rather than assumed.
    expect(transcriptAppendOnlyTables).toEqual(["transcript_updates"]);
    const { created } = store();
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
    await created.appendUpdates("c1", [update("kept")]);
    await expect(created.appendUpdates("c1", []).then(() => "no rows appended")).resolves.toBe(
      "no rows appended",
    );
    expect(await created.hasHistory("c1")).toBe(true);
    expect(await created.hasHistory("c2")).toBe(false);
  });

  it("keeps one conversation's updates out of another's", async () => {
    const { created } = store();
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
    await created.upsertConversation({ conversationId: "c2", taskId: null, cwd: "/b" });
    await created.appendUpdates("c1", [update("mine")]);
    await created.appendUpdates("c2", [update("theirs")]);
    expect((await created.history("c1", null)).updates).toHaveLength(1);
    expect((await created.history("c2", null)).updates[0]?.seq).toBe(1);
  });
});

describe("turns", () => {
  it("records what was asked and how the turn ended", async () => {
    const { created } = store();
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
    const first = await created.startTurn({
      conversationId: "c1",
      prompt: [{ type: "text", text: "do the tests pass?" }],
    });
    expect(first.seq).toBe(1);
    await created.endTurn(first.turnId, "end_turn");
    const second = await created.startTurn({ conversationId: "c1", prompt: [] });
    expect(second.seq).toBe(2);
    // A refused prompt has no ACP stop reason, so the code that describes it is stored in its place.
    await created.endTurn(second.turnId, "chat.key_required");
  });
});

describe("the database file", () => {
  it("runs in WAL, so a read while the harness is appending does not block", async () => {
    const { created, path } = store();
    await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
    const raw = new DatabaseSync(path);
    const mode = raw.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    raw.close();
    expect(mode.journal_mode).toBe("wal");
  });

  it("opens under NODE_ENV=production, because here SQLite is the real store", async () => {
    // `LocalSqliteClient` refuses production, since in the cloud it is a stand-in for D1. On the desktop
    // it is not a stand-in for anything, so the guard is answered rather than tripped over by whatever a
    // packaged app happens to have in its environment.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { created } = store();
      await created.upsertConversation({ conversationId: "c1", taskId: null, cwd: "/a" });
      expect((await created.conversation("c1"))?.cwd).toBe("/a");
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
