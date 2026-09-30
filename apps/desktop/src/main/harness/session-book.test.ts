import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "../transcripts.ts";
import { transcriptSessionBook } from "./session-book.ts";

/*
 * These run against a real `TranscriptStore` on a real file rather than a fake, because every claim worth
 * making here is about what SQLite does with the two statements: that `set` overwrites an id the upsert's
 * `COALESCE` would otherwise preserve, and that it works when no row exists yet. A fake store would agree
 * with whatever this adapter did and prove none of it.
 */
const directories: string[] = [];
const stores: TranscriptStore[] = [];

const ROOT = "/Users/someone";

function store(): TranscriptStore {
  const directory = mkdtempSync(join(tmpdir(), "symplist-session-book-"));
  directories.push(directory);
  const created = new TranscriptStore({ path: join(directory, "transcripts.sqlite") });
  stores.push(created);
  return created;
}

afterEach(() => {
  for (const open of stores.splice(0)) open.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("the transcript store as a session book", () => {
  it("answers null for a conversation it has never seen", async () => {
    const book = transcriptSessionBook(store(), ROOT);
    expect(await book.get("c1")).toBeNull();
  });

  it("stores a session id for a conversation that has no row yet", async () => {
    // The supervisor calls `set` right after `session/new`, which can be the first thing that ever
    // happens to a conversation. An UPDATE alone would touch no rows and resume would never work.
    const book = transcriptSessionBook(store(), ROOT);
    await book.set("c1", "acp-1");
    expect(await book.get("c1")).toBe("acp-1");
  });

  it("replaces an id that is already stored", async () => {
    // `upsertConversation` coalesces, so it cannot move the pointer on its own; this is the case that
    // proves the second write is doing the work.
    const book = transcriptSessionBook(store(), ROOT);
    await book.set("c1", "acp-1");
    await book.set("c1", "acp-2");
    expect(await book.get("c1")).toBe("acp-2");
  });

  it("forgets an id so the next launch does not retry a session the agent refused", async () => {
    const book = transcriptSessionBook(store(), ROOT);
    await book.set("c1", "acp-1");
    await book.forget("c1");
    expect(await book.get("c1")).toBeNull();
  });

  it("keeps the conversation and its workspace when the session is forgotten", async () => {
    // Forgetting the session must not forget the conversation: the transcript is what survives a
    // failed resume, and the pane still has to be able to show it.
    const created = store();
    const book = transcriptSessionBook(created, ROOT);
    await book.set("c1", "acp-1");
    await book.forget("c1");
    const conversation = await created.conversation("c1");
    expect(conversation).toMatchObject({ conversationId: "c1", cwd: ROOT, acpSessionId: null });
  });

  it("leaves a conversation's recorded task and directory alone when it stores a new id", async () => {
    // A conversation opened for a task is upserted with that task before any session exists. `set` must
    // not blank it out, because `conversationForTask` is how the task's panel finds its way back.
    const created = store();
    await created.upsertConversation({ conversationId: "c1", taskId: "t1", cwd: ROOT });
    await transcriptSessionBook(created, "/somewhere/else").set("c1", "acp-1");
    expect(await created.conversationForTask("t1")).toMatchObject({
      conversationId: "c1",
      cwd: ROOT,
      acpSessionId: "acp-1",
    });
  });
});
