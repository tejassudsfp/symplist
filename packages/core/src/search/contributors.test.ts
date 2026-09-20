import { encryptFieldText } from "@symplist/crypto";
import { int, sql, uuidv7, writeGuard } from "@symplist/db";
import { buildSectionIndex, DocumentArtifacts } from "@symplist/docs";
import { FakeClock, FakeTriggerClient } from "@symplist/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountObjectPrefix } from "../account/deletion.ts";
import { AccountPurgeRunner } from "../account/purge.ts";
import { accountPurgeContributor } from "../account/purge-contributors/account.ts";
import { purgeContributors } from "../account/purge-contributors/index.ts";
import { searchPurgeContributor } from "../account/purge-contributors/search.ts";
import { preferencesContext } from "../preferences/service.ts";
import { simonField } from "../simon/repository.ts";
import { archiveContributors } from "../tasks/archive-contributors/index.ts";
import { searchArchiveContributor } from "../tasks/archive-contributors/search.ts";
import type { ArchiveInput } from "../tasks/archive-contributors/types.ts";
import { archiveContributionStatements } from "../tasks/archive-runner.ts";
import {
  enqueueSearchIndex,
  SEARCH_INDEX_TASK_ID,
  searchIndexIdempotencyKey,
  searchIndexPayloadSchema,
  staleSearchOwners,
} from "./enqueue.ts";
import {
  countRows,
  createSearchTestStore,
  insertOwner,
  ownerKey,
  recordIntent,
  type SearchTestStore,
  writeTask,
} from "./harness.test-support.ts";
import { coalesceIntents, searchIntentStatement } from "./intents.ts";
import { D1DocumentTextSource } from "./sources/contributors/documents.ts";
import { createSearchSources, searchSourceContributors } from "./sources/contributors/index.ts";
import { D1ChatOptInSource } from "./sources/contributors/preferences.ts";
import { D1MessageTextSource } from "./sources/contributors/simon.ts";
import { D1SearchTaskSource } from "./sources/tasks.ts";
import { SearchIndexWriter } from "./writer.ts";

let store: SearchTestStore;
let owner: string;

beforeEach(async () => {
  store = await createSearchTestStore();
  owner = await insertOwner(store, "maya@example.test");
});

afterEach(() => {
  store.close();
});

describe("search intents (§10.1)", () => {
  it("records an intent only when the guarding write committed", async () => {
    const task = await writeTask(store, owner, { title: "Guarded" }, { intent: false });
    const committed = writeGuard({ table: "tasks", id: task });
    await store.db.batch([
      sql(`UPDATE tasks SET write_id = :w WHERE id = :id`, { w: committed.writeId, id: task }),
      searchIntentStatement(
        {
          ownerId: owner,
          entity: "task",
          entityId: task,
          revisionOrSeq: 2,
          op: "upsert",
          now: store.now,
        },
        committed,
      ),
    ]);
    const lost = writeGuard({ table: "tasks", id: task });
    await store.db.batch([
      sql(`UPDATE tasks SET write_id = :w WHERE id = :id AND version = 99`, {
        w: lost.writeId,
        id: task,
      }),
      searchIntentStatement(
        {
          ownerId: owner,
          entity: "task",
          entityId: task,
          revisionOrSeq: 3,
          op: "upsert",
          now: store.now,
        },
        lost,
      ),
    ]);
    expect(await countRows(store, "search_intents", owner)).toBe(1);
  });

  it("validates its input", () => {
    const base = { ownerId: owner, entityId: uuidv7(), revisionOrSeq: 1, now: 1 };
    expect(() =>
      searchIntentStatement({ ...base, entity: "vault" as never, op: "upsert" }),
    ).toThrow(TypeError);
    expect(() =>
      searchIntentStatement({ ...base, entity: "task", op: "upsert", revisionOrSeq: -1 }),
    ).toThrow(TypeError);
    expect(() =>
      searchIntentStatement(
        { ...base, entity: "task", op: "upsert" },
        { exists: "1", params: { owner: "x" } },
      ),
    ).toThrow(TypeError);
  });

  it("coalesces to the last operation per entity", () => {
    const row = (
      id: number,
      entity: "task" | "document",
      entityId: string,
      op: "upsert" | "delete",
    ) => ({
      id,
      entity,
      entityId,
      revisionOrSeq: 1,
      op,
      createdAt: 1,
    });
    const coalesced = coalesceIntents([
      row(3, "task", "a", "delete"),
      row(1, "task", "a", "upsert"),
      row(2, "document", "a", "upsert"),
      row(4, "task", "b", "upsert"),
    ]);
    expect([...coalesced.tasks]).toEqual([
      ["a", "delete"],
      ["b", "upsert"],
    ]);
    expect([...coalesced.documents]).toEqual([["a", "upsert"]]);
  });
});

describe("the search archive contributor (§2.1)", () => {
  /**
   * The archive intents themselves belong to the tasks domain, which owns `tasks` and the deciding
   * statement: `tasks/plans.ts` records one upsert per archived *and* promoted task in the same
   * batch, and `tasks/service.test.ts` — "inserts a search intent for every task a completion
   * archives or promotes (§10.1)" — pins that. What is search's to keep is its place in the seam,
   * and the fact that it contributes nothing that would write those intents a second time.
   */
  it("is registered, contributes no statements, and never doubles the plan's intents", async () => {
    expect(archiveContributors).toContain(searchArchiveContributor);
    const root = await writeTask(store, owner, { title: "Root" }, { intent: false });
    const child = await writeTask(
      store,
      owner,
      { title: "Child", parentId: root },
      { intent: false },
    );
    const writeId = uuidv7(store.now);
    const input: ArchiveInput = {
      ownerId: owner,
      rootTaskId: root,
      taskIds: [root, child],
      mode: "all" as const,
      writeId,
      now: store.now,
      stopRun: false,
      archivedTaskIds: {
        sql: "SELECT id FROM tasks WHERE owner_id = :archive_ids_owner AND archived_with_root_id = :archive_ids_root AND write_id = :archive_ids_write",
        params: {
          archive_ids_owner: owner,
          archive_ids_root: root,
          archive_ids_write: writeId,
        },
      },
    };
    expect(searchArchiveContributor.statements(input)).toEqual([]);
    expect(searchArchiveContributor.statements({ ...input, taskIds: [] })).toEqual([]);

    // The archive statement commits and no intent appears from this seam: whatever search_intents
    // holds after a completion came from the plan, once per task.
    await store.db.batch([
      sql(
        `UPDATE tasks SET status = 'archived', archived_at = :now, write_id = :w WHERE id IN (:ids)`,
        { now: int(store.now), w: writeId, ids: [root, child] },
      ),
      ...archiveContributionStatements(archiveContributors, input),
    ]);
    expect(await countRows(store, "search_intents", owner)).toBe(0);
  });

  it("keeps every registered contribution acceptable to the archive runner", () => {
    // The runner refuses a statement that writes `tasks` or `users`, or that omits the archive
    // guard; a contributor written against an older shape of the seam fails the whole completion
    // with a 500 rather than at its own test.
    const writeId = uuidv7(store.now);
    const input: ArchiveInput = {
      ownerId: owner,
      rootTaskId: "01920000-0000-7000-8000-00000000r001",
      taskIds: ["01920000-0000-7000-8000-00000000r001"],
      mode: "all",
      writeId,
      now: store.now,
      stopRun: true,
      archivedTaskIds: { sql: "SELECT id FROM tasks WHERE 0", params: {} },
    };
    expect(() => archiveContributionStatements(archiveContributors, input)).not.toThrow();
  });
});

describe("the search purge contributor (§5.6)", () => {
  it("is registered before tasks and deletes intents and index rows in bounded batches", async () => {
    const names = purgeContributors.map((contributor) => contributor.domain);
    expect(names.indexOf("search")).toBeLessThan(names.indexOf("tasks"));
    expect(names.indexOf("search")).toBeLessThan(names.indexOf("account"));

    for (let index = 0; index < 7; index += 1)
      await writeTask(store, owner, { title: `Task ${index}` });
    await new SearchIndexWriter({
      db: store.db,
      objects: store.objects,
      keys: store.keys,
      sources: store.sources,
      now: () => store.now,
      batchLimit: 1,
    }).run(owner, { mode: "local" });
    for (let index = 0; index < 5; index += 1) await recordIntent(store, owner, "task", uuidv7());
    const other = await insertOwner(store, "kept@example.test");
    await recordIntent(store, other, "task", uuidv7());

    const input = { userId: owner, batchLimit: 2 };
    let batches = 0;
    for (;;) {
      const results = await store.db.batch([
        ...searchPurgeContributor.statements(input),
        ...(searchPurgeContributor.remaining?.(input) ?? []),
      ]);
      batches += 1;
      if (results[results.length - 1]?.results[0]?.remaining === 0) break;
    }
    expect(batches).toBeGreaterThan(2);
    expect(await countRows(store, "search_intents", owner)).toBe(0);
    expect(await countRows(store, "search_indexes", owner)).toBe(0);
    expect(await countRows(store, "search_intents", other)).toBe(1);
  });

  it("leaves nothing of the account after a full purge, index objects included", async () => {
    await writeTask(store, owner, { title: "Soon gone" });
    await new SearchIndexWriter({
      db: store.db,
      objects: store.objects,
      keys: store.keys,
      sources: store.sources,
      now: () => store.now,
    }).run(owner, { mode: "local" });
    await recordIntent(store, owner, "task", uuidv7());
    await store.db.batch([
      sql(
        `UPDATE users SET deletion_state = 'deleting', deletion_requested_at = :now WHERE id = :user`,
        { now: int(store.now), user: owner },
      ),
      sql(`DELETE FROM account_keys WHERE owner_id = :user`, { user: owner }),
      sql(
        `INSERT INTO account_deletions (user_id, analytics_id, email_digest, email_digest_version,
           composio_user_id, r2_prefix, requested_at, status, steps_done, updated_at, write_id)
         VALUES (:user, NULL, 'digest', 1, :user, :prefix, :now, 'pending', '[]', :now, 'w')`,
        { user: owner, prefix: accountObjectPrefix(owner), now: int(store.now) },
      ),
    ]);
    const done = { run: async () => "done" as const };
    // The tasks domain's own purge is built by the workspace feature; a stand-in removes task rows.
    const tasksStandIn = {
      domain: "tasks" as const,
      statements: ({ userId }: { userId: string }) => [
        sql(`DELETE FROM tasks WHERE owner_id = :user`, { user: userId }),
      ],
      remaining: ({ userId }: { userId: string }) => [
        sql(`SELECT EXISTS (SELECT 1 FROM tasks WHERE owner_id = :user) AS remaining`, {
          user: userId,
        }),
      ],
    };
    const runner = new AccountPurgeRunner({
      db: store.db,
      store: store.objects,
      now: () => store.now,
      runs: done,
      composio: done,
      contributors: [searchPurgeContributor, tasksStandIn, accountPurgeContributor],
    });
    let result = await runner.run(owner);
    while (result.status === "incomplete") result = await runner.run(owner);
    expect(result.status).toBe("done");
    expect(await countRows(store, "search_intents", owner)).toBe(0);
    expect(await countRows(store, "search_indexes", owner)).toBe(0);
    expect((await store.objects.list({ prefix: accountObjectPrefix(owner) })).objects).toEqual([]);
  });
});

describe("enqueueing the durable writer (§10.1)", () => {
  it("uses an ids-only payload, the 30-second window key and a 30-second delay", async () => {
    const clock = new FakeClock();
    const trigger = new FakeTriggerClient({ clock });
    const now = 1_789_500_010_000;
    await enqueueSearchIndex(trigger, owner, now);
    await enqueueSearchIndex(trigger, owner, now + 5_000);
    await enqueueSearchIndex(trigger, owner, now + 30_000);
    expect(trigger.triggers.map((record) => record.options?.idempotencyKey)).toEqual([
      searchIndexIdempotencyKey(owner, now),
      searchIndexIdempotencyKey(owner, now),
      searchIndexIdempotencyKey(owner, now + 30_000),
    ]);
    expect(trigger.triggers[0]).toMatchObject({
      taskIdentifier: SEARCH_INDEX_TASK_ID,
      payload: { ownerId: owner },
      options: { delay: "30s" },
    });
    expect(new Set(trigger.triggers.map((record) => record.runId)).size).toBe(2);
    expect(() => searchIndexPayloadSchema.parse({ ownerId: owner, title: "no content" })).toThrow();
  });

  it("finds owners whose intents waited too long, oldest first", async () => {
    const waiting = await insertOwner(store, "waiting@example.test");
    await recordIntent(store, waiting, "task", uuidv7());
    store.now += 60_000;
    await recordIntent(store, owner, "task", uuidv7());
    store.now += 5 * 60_000;
    expect(
      await staleSearchOwners(store.db, { now: store.now, olderThanMs: 5 * 60_000, limit: 10 }),
    ).toEqual([waiting, owner]);
    expect(
      await staleSearchOwners(store.db, {
        now: store.now,
        olderThanMs: 5 * 60_000 + 30_000,
        limit: 10,
      }),
    ).toEqual([waiting]);
  });
});

describe("search sources", () => {
  it("builds sources from the contributors and refuses two suppliers of one source", () => {
    const sources = createSearchSources({ db: store.db, objects: store.objects, keys: store.keys });
    expect(sources.tasks).toBeInstanceOf(D1SearchTaskSource);
    expect(sources.documents).toBeInstanceOf(D1DocumentTextSource);
    expect(sources.messages).toBeInstanceOf(D1MessageTextSource);
    expect(sources.chatOptIn).toBeInstanceOf(D1ChatOptInSource);
    expect(searchSourceContributors.map((contributor) => contributor.domain)).toEqual([
      "documents",
      "simon",
      "preferences",
      "scheduling",
    ]);
    const twice = [
      { domain: "documents" as const, documents: () => store.documents },
      { domain: "simon" as const, documents: () => store.documents },
    ];
    expect(() =>
      createSearchSources({ db: store.db, objects: store.objects, keys: store.keys }, twice),
    ).toThrow(/Only one domain/);
  });

  it("reads only the owner's tasks and skips titles that do not decrypt", async () => {
    const other = await insertOwner(store, "other@example.test");
    const mine = await writeTask(store, owner, { title: "Mine" });
    const theirs = await writeTask(store, other, { title: "Theirs" });
    const broken = await writeTask(store, owner, { title: "Broken" });
    await store.db.run(
      sql(`UPDATE tasks SET title_enc = :bad WHERE id = :id`, {
        bad: "sym1.1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        id: broken,
      }),
    );
    const warnings: string[] = [];
    const source = new D1SearchTaskSource(store.db, {
      info: () => undefined,
      warn: (event) => warnings.push(event),
      error: () => undefined,
    });
    const key = await ownerKey(store, owner);
    const read = await source.readTasks(owner, [mine, theirs, broken], key);
    expect([...read.keys()]).toEqual([mine]);
    expect(warnings).toEqual(["search.task_unreadable"]);
    const listed = await source.listTasks(owner, { after: null, limit: 10 }, key);
    expect(listed.map((task) => task.title)).toEqual(["Mine"]);
  });

  it("reads only current owner document heads with frozen snapshot AAD and stable cursors", async () => {
    const mine = await writeTask(store, owner, { title: "Document task" });
    const other = await insertOwner(store, "document-other@example.test");
    const theirs = await writeTask(store, other, { title: "Other document" });
    const key = await ownerKey(store, owner);
    const artifacts = new DocumentArtifacts({ objects: store.objects });
    const commit = "a".repeat(40);
    const markdown = "# Plan\n\nprivate document marker\n";
    await artifacts.putSnapshot(
      key,
      {
        taskId: mine,
        commitId: commit,
        parentCommitId: null,
        generation: 1,
        author: "user",
        kind: "create",
        restoredFrom: null,
        committedAt: store.now,
        subject: "Created Plan",
        markdown,
        index: buildSectionIndex(markdown, commit),
      },
      uuidv7(store.now),
    );
    await store.db.batch([
      sql(
        `INSERT INTO doc_repos (task_id, owner_id, head_commit_id, generation, commit_count, bundle_key,
         bundle_write_id, bundle_bytes, snapshot_key, document_bytes, head_author, format_version,
         key_version, created_at, updated_at, write_id)
         VALUES (:task, :owner, :commit, 1, 1, 'bundle', :write, 0, :snapshot, :bytes, 'user', 1, 1,
         :now, :now, :write)`,
        {
          task: mine,
          owner,
          commit,
          write: uuidv7(store.now),
          snapshot: `u/${owner}/docs/${mine}/${commit}.md.sym`,
          bytes: int(Buffer.byteLength(markdown)),
          now: int(store.now),
        },
      ),
      sql(
        `INSERT INTO doc_repos (task_id, owner_id, head_commit_id, generation, commit_count, bundle_key,
         bundle_write_id, bundle_bytes, snapshot_key, document_bytes, head_author, format_version,
         key_version, created_at, updated_at, write_id)
         VALUES (:task, :owner, :commit, 1, 1, 'bundle', :write, 0, 'bad-key', 0, 'user', 1, 1,
         :now, :now, :write)`,
        { task: theirs, owner: other, commit, write: uuidv7(store.now), now: int(store.now) },
      ),
    ]);
    const source = new D1DocumentTextSource(store.db, store.objects);
    expect(await source.listHeads(owner, { after: null, limit: 1 })).toEqual([
      { taskId: mine, revision: commit },
    ]);
    expect(await source.listHeads(owner, { after: mine, limit: 1 })).toEqual([]);
    const read = await source.readHeads(owner, [mine, theirs], key);
    expect(read.get(mine)?.sections[0]).toMatchObject({
      heading: "Plan",
      text: "Planprivate document marker",
    });
    expect(read.has(theirs)).toBe(false);
    await store.db.run(
      sql(
        `UPDATE tasks SET status = 'archived', archived_at = :now WHERE id = :task AND owner_id = :owner`,
        { task: mine, owner, now: int(store.now) },
      ),
    );
    expect(await source.listHeads(owner, { after: null, limit: 1 })).toEqual([
      { taskId: mine, revision: commit },
    ]);
    await expect(source.listHeads(owner, { after: null, limit: 101 })).rejects.toThrow(RangeError);
    await store.db.run(
      sql(`UPDATE users SET beta_state = 'relocked' WHERE id = :owner`, { owner }),
    );
    expect(await source.listHeads(owner, { after: null, limit: 1 })).toEqual([]);
  });

  it("keeps quick/corrupt/foreign Simon messages out and fails privacy closed", async () => {
    const task = await writeTask(store, owner, { title: "Chat task" });
    const other = await insertOwner(store, "chat-other@example.test");
    const otherTask = await writeTask(store, other, { title: "Other chat task" });
    const conversation = uuidv7(store.now);
    const quick = uuidv7(store.now);
    const foreignConversation = uuidv7(store.now);
    const message = uuidv7(store.now);
    const corrupt = uuidv7(store.now);
    const quickMessage = uuidv7(store.now);
    const foreignMessage = uuidv7(store.now);
    const key = await ownerKey(store, owner);
    const otherKey = await ownerKey(store, other);
    await store.db.batch([
      sql(
        `INSERT INTO conversations (id, owner_id, kind, task_id, expires_at, created_at, updated_at, write_id)
         VALUES (:id, :owner, 'task', :task, NULL, :now, :now, :id)`,
        { id: conversation, owner, task, now: int(store.now) },
      ),
      sql(
        `INSERT INTO conversations (id, owner_id, kind, task_id, expires_at, created_at, updated_at, write_id)
         VALUES (:id, :owner, 'quick', NULL, :expiry, :now, :now, :id)`,
        { id: quick, owner, expiry: int(store.now + 1), now: int(store.now) },
      ),
      sql(
        `INSERT INTO conversations (id, owner_id, kind, task_id, expires_at, created_at, updated_at, write_id)
         VALUES (:id, :owner, 'task', :task, NULL, :now, :now, :id)`,
        { id: foreignConversation, owner: other, task: otherTask, now: int(store.now) },
      ),
      ...(
        [
          {
            id: message,
            ownerId: owner,
            conversationId: conversation,
            role: "user",
            seq: 1,
            content: encryptFieldText(
              key,
              simonField(owner, "messages", message, "content_enc"),
              "owner marker",
            ),
          },
          {
            id: corrupt,
            ownerId: owner,
            conversationId: conversation,
            role: "assistant",
            seq: 2,
            content: "sym1.1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
          {
            id: quickMessage,
            ownerId: owner,
            conversationId: quick,
            role: "user",
            seq: 1,
            content: encryptFieldText(
              key,
              simonField(owner, "messages", quickMessage, "content_enc"),
              "quick marker",
            ),
          },
          {
            id: foreignMessage,
            ownerId: other,
            conversationId: foreignConversation,
            role: "user",
            seq: 1,
            content: encryptFieldText(
              otherKey,
              simonField(other, "messages", foreignMessage, "content_enc"),
              "foreign marker",
            ),
          },
        ] satisfies ReadonlyArray<{
          readonly id: string;
          readonly ownerId: string;
          readonly conversationId: string;
          readonly role: "user" | "assistant";
          readonly seq: number;
          readonly content: string;
        }>
      ).map((record) =>
        sql(
          `INSERT INTO messages (id, owner_id, conversation_id, run_id, request_id, seq, role, status, tier,
           content_enc, request_fingerprint_enc, created_at, write_id)
           VALUES (:id, :owner, :conversation, NULL, :request, :seq, :role, 'completed', 'fast', :content,
           :fingerprint, :now, :id)`,
          {
            id: record.id,
            owner: record.ownerId,
            conversation: record.conversationId,
            request: `request:${record.id}`,
            seq: int(record.seq),
            role: record.role,
            content: record.content,
            fingerprint: record.content,
            now: int(store.now),
          },
        ),
      ),
    ]);
    const messages = new D1MessageTextSource(store.db);
    expect(await messages.listMessages(owner, { after: null, limit: 100 })).toEqual(
      [corrupt, message].sort(),
    );
    await expect(messages.listMessages(owner, { after: null, limit: 101 })).rejects.toThrow(
      RangeError,
    );
    expect(
      await messages.readMessages(owner, [message, corrupt, quickMessage, foreignMessage], key),
    ).toEqual(
      new Map([
        [
          message,
          {
            id: message,
            taskId: task,
            conversationId: conversation,
            speaker: "user",
            createdAt: store.now,
            text: "owner marker",
          },
        ],
      ]),
    );

    const privacy = new D1ChatOptInSource(store.db);
    expect(await privacy.includeChat(owner, key)).toBe(false);
    await store.db.run(
      sql(
        `INSERT INTO user_preferences (owner_id, "group", version, data_enc, updated_at, write_id)
         VALUES (:owner, 'privacy', 1, :data, :now, :write)`,
        {
          owner,
          data: encryptFieldText(
            key,
            preferencesContext(owner, "privacy"),
            JSON.stringify({ includeChatInSearch: true }),
          ),
          now: int(store.now),
          write: uuidv7(store.now),
        },
      ),
    );
    expect(await privacy.includeChat(owner, key)).toBe(true);
    await store.db.run(
      sql(`UPDATE user_preferences SET data_enc = 'corrupt' WHERE owner_id = :owner`, { owner }),
    );
    expect(await privacy.includeChat(owner, key)).toBe(false);
    expect(
      searchSourceContributors.some((contributor) => contributor.domain === ("vault" as never)),
    ).toBe(false);
  });
});
