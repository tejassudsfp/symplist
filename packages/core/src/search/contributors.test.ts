import { int, sql, uuidv7, writeGuard } from "@symplist/db";
import { FakeClock, FakeTriggerClient } from "@symplist/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountObjectPrefix } from "../account/deletion.ts";
import { AccountPurgeRunner } from "../account/purge.ts";
import { accountPurgeContributor } from "../account/purge-contributors/account.ts";
import { purgeContributors } from "../account/purge-contributors/index.ts";
import { searchPurgeContributor } from "../account/purge-contributors/search.ts";
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
import { createSearchSources, searchSourceContributors } from "./sources/contributors/index.ts";
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
    expect(sources.documents).toBeNull();
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
});
