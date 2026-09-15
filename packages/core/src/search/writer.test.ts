import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptObject, zeroize } from "@symplist/crypto";
import { type DbClient, DbUnknownOutcomeError, int, sql, uuidv7 } from "@symplist/db";
import {
  INDEX_FORMAT_VERSION,
  openSearchIndex,
  parseQuery,
  parseSearchIndexObjectKey,
  runSearch,
  SEARCH_INDEX_OBJECT_KIND,
  SearchView,
  searchIndexObjectKey,
  searchIndexObjectPrefix,
  TOKENIZER_FINGERPRINT,
} from "@symplist/search";
import type { ObjectStore } from "@symplist/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countRows,
  createSearchTestStore,
  insertOwner,
  ownerKey,
  recordIntent,
  type SearchTestStore,
  setExecutorMode,
  writeTask,
} from "./harness.test-support.ts";
import type { SearchLog } from "./log.ts";
import { searchIndexRowFromDb, searchIndexRowStatement } from "./state.ts";
import { SearchIndexWriter, type SearchIndexWriterOptions } from "./writer.ts";

let store: SearchTestStore;
let owner: string;
const events: { level: string; event: string; fields: Record<string, unknown> }[] = [];
const log: SearchLog = {
  info: (event, fields) => events.push({ level: "info", event, fields: { ...fields } }),
  warn: (event, fields) => events.push({ level: "warn", event, fields: { ...fields } }),
  error: (event, fields) => events.push({ level: "error", event, fields: { ...fields } }),
};

function writer(overrides: Partial<SearchIndexWriterOptions> = {}): SearchIndexWriter {
  return new SearchIndexWriter({
    db: store.db,
    objects: store.objects,
    keys: store.keys,
    sources: store.sources,
    now: () => store.now,
    log,
    ...overrides,
  });
}

async function indexRow(ownerId = owner) {
  return searchIndexRowFromDb(
    (await store.db.first(searchIndexRowStatement(ownerId))) ?? undefined,
  );
}

/** Opens the published index of an owner and runs a query over it. */
async function publishedTitles(query: string, ownerId = owner, types = ["tasks", "documents"]) {
  const row = await indexRow(ownerId);
  if (!row) throw new Error("no published index");
  const stored = await store.objects.get(row.objectKey);
  if (!stored) throw new Error("missing index object");
  const key = await ownerKey(store, ownerId);
  const parsed = parseSearchIndexObjectKey(ownerId, row.objectKey);
  const opened = openSearchIndex(key, stored.body, {
    ownerId,
    generation: row.generation,
    writeId: parsed?.writeId ?? "",
  });
  zeroize(key.key);
  return runSearch(SearchView.of(opened.index), parseQuery(query), {
    collections: new Set(["now", "later", "unclassified"]),
    archive: "include",
    types: new Set(types as ("tasks" | "documents" | "chat")[]),
    taskIds: null,
    chat: types.includes("chat"),
  }).groups.map((group) => group.task.title);
}

async function objectKeys(ownerId = owner): Promise<string[]> {
  const listed = await store.objects.list({ prefix: searchIndexObjectPrefix(ownerId) });
  return listed.objects.map((object) => object.key);
}

beforeEach(async () => {
  store = await createSearchTestStore();
  owner = await insertOwner(store, "maya@example.test");
  events.length = 0;
});

afterEach(() => {
  store.close();
});

describe("SearchIndexWriter (§10.1)", () => {
  it("publishes the first generation with an encrypted object and deletes applied intents", async () => {
    await writeTask(store, owner, { title: "Send the project outline" });
    await writeTask(store, owner, { title: "Book a bike tune-up", collection: "later" });
    expect(await countRows(store, "search_intents", owner)).toBe(2);

    const outcome = await writer().run(owner, { mode: "local" });
    expect(outcome).toMatchObject({
      status: "published",
      generation: 1,
      pending: 0,
      rebuilt: true,
    });
    const row = await indexRow();
    expect(row).toMatchObject({
      generation: 1,
      indexFormatVersion: INDEX_FORMAT_VERSION,
      tokenizerFingerprint: TOKENIZER_FINGERPRINT,
      includeChat: false,
      truncated: false,
    });
    expect(row?.appliedThrough).toBeGreaterThan(0);
    expect(row?.objectKey).toBe(searchIndexObjectKey(owner, 1, row?.writeId ?? ""));
    expect(await countRows(store, "search_intents", owner)).toBe(0);
    expect(await publishedTitles("outline")).toEqual(["Send the project outline"]);

    const stored = await store.objects.get(row?.objectKey ?? "");
    expect(stored?.metadata["write-id"]).toBe(row?.writeId);
    expect(Buffer.from(stored?.body ?? []).toString("latin1")).not.toContain("outline");
    // The object is bound to its owner, generation and write id.
    const key = await ownerKey(store, owner);
    expect(() =>
      decryptObject(
        key,
        {
          kind: SEARCH_INDEX_OBJECT_KIND,
          ownerId: owner,
          objectId: `2-${row?.writeId}`,
          formatVersion: 1,
        },
        stored?.body ?? new Uint8Array(),
      ),
    ).toThrow();
    // Logs carry ids and counts, never content.
    expect(JSON.stringify(events)).not.toMatch(/outline|bike/i);
  });

  it("reports up to date when nothing is pending, without writing", async () => {
    await writeTask(store, owner, { title: "Only task" });
    await writer().run(owner, { mode: "local" });
    const before = await objectKeys();
    expect(await writer().run(owner, { mode: "local" })).toEqual({
      status: "up_to_date",
      generation: 1,
    });
    expect(await objectKeys()).toEqual(before);
  });

  it("applies creation, update and delete intents to the next generation and sweeps the old object", async () => {
    const renamed = await writeTask(store, owner, { title: "Draft invoice" });
    const removed = await writeTask(store, owner, { title: "Old errand" });
    await writer().run(owner, { mode: "local" });
    const first = await indexRow();

    await writeTask(store, owner, { id: renamed, title: "Send receipt", version: 2 });
    await writeTask(store, owner, { title: "Brand new task" });
    await store.db.run(sql(`DELETE FROM tasks WHERE id = :id`, { id: removed }));
    await recordIntent(store, owner, "task", removed, "delete");

    const outcome = await writer().run(owner, { mode: "local" });
    expect(outcome).toMatchObject({
      status: "published",
      generation: 2,
      rebuilt: false,
      intentCount: 3,
    });
    expect(await publishedTitles("invoice")).toEqual([]);
    expect(await publishedTitles("receipt")).toEqual(["Send receipt"]);
    expect(await publishedTitles("brand")).toEqual(["Brand new task"]);
    expect(await publishedTitles("errand")).toEqual([]);
    expect(await objectKeys()).toEqual([(await indexRow())?.objectKey]);
    expect(await store.objects.get(first?.objectKey ?? "")).toBeNull();
  });

  it("re-reads current heads for document intents, including changed revisions and removed heads", async () => {
    const task = await writeTask(store, owner, { title: "Trip" });
    store.documents.publishMarkdown(owner, task, "## Hotel\nBook the lakeside inn", "rev1");
    await recordIntent(store, owner, "document", task);
    await writer().run(owner, { mode: "local" });
    expect(await publishedTitles("lakeside")).toEqual(["Trip"]);

    store.documents.publishMarkdown(owner, task, "## Train\nReserve window seats", "rev2");
    await recordIntent(store, owner, "document", task, "upsert", 2);
    await writer().run(owner, { mode: "local" });
    expect(await publishedTitles("lakeside")).toEqual([]);
    expect(await publishedTitles("window seats")).toEqual(["Trip"]);

    store.documents.remove(owner, task);
    await recordIntent(store, owner, "document", task, "upsert", 3);
    await writer().run(owner, { mode: "local" });
    expect(await publishedTitles("seats")).toEqual([]);
  });

  it("applies bounded batches and reports what is still pending", async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeTask(store, owner, { title: `Task number ${index}` });
    }
    await writer().run(owner, { mode: "local" });
    for (let index = 0; index < 5; index += 1) {
      await writeTask(store, owner, { title: `Later task ${index}` });
    }
    const bounded = writer({ batchLimit: 2 });
    expect(await bounded.run(owner, { mode: "local" })).toMatchObject({
      status: "published",
      pending: 3,
    });
    expect(await bounded.run(owner, { mode: "local" })).toMatchObject({
      status: "published",
      pending: 1,
    });
    expect(await bounded.run(owner, { mode: "local" })).toMatchObject({
      status: "published",
      pending: 0,
    });
    expect((await publishedTitles("later")).length).toBe(5);
    expect(await countRows(store, "search_intents", owner)).toBe(0);
  });

  it("lets exactly one of two concurrent writers publish a generation", async () => {
    await writeTask(store, owner, { title: "Concurrent" });
    let uploads = 0;
    let release: () => void = () => undefined;
    const bothUploaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier: ObjectStore = {
      ...store.objects,
      get: (key) => store.objects.get(key),
      head: (key) => store.objects.head(key),
      list: (input) => store.objects.list(input),
      delete: (key) => store.objects.delete(key),
      put: async (input) => {
        const result = await store.objects.put(input);
        uploads += 1;
        if (uploads === 2) release();
        await bothUploaded;
        return result;
      },
    };
    const outcomes = await Promise.all([
      writer({ objects: barrier }).run(owner, { mode: "local" }),
      writer({ objects: barrier }).run(owner, { mode: "local" }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["conflict", "published"]);
    const row = await indexRow();
    expect(row?.generation).toBe(1);
    expect(await objectKeys()).toEqual([row?.objectKey]);
    expect(await publishedTitles("concurrent")).toEqual(["Concurrent"]);
  });

  it("recovers from indexing interrupted between upload and publication", async () => {
    await writeTask(store, owner, { title: "Resilient" });
    const failing: DbClient = {
      ...store.db,
      batch: async (statements, options) => {
        if (statements.some((statement) => statement.sql.includes("INSERT INTO search_indexes"))) {
          throw new Error("connection reset");
        }
        return store.db.batch(statements, options);
      },
      all: (statement, options) => store.db.all(statement, options),
      first: (statement, options) => store.db.first(statement, options),
      run: (statement, options) => store.db.run(statement, options),
    };
    await expect(writer({ db: failing }).run(owner, { mode: "local" })).rejects.toThrow(
      "connection reset",
    );
    expect(await indexRow()).toBeNull();
    expect(await countRows(store, "search_intents", owner)).toBe(1);
    expect(await objectKeys()).toEqual([]);

    // A writer that died after uploading leaves an orphan object; the next publication sweeps it.
    const orphan = searchIndexObjectKey(owner, 1, uuidv7(store.now));
    await store.objects.put({ key: orphan, body: new Uint8Array([1, 2, 3]) });
    expect(await writer().run(owner, { mode: "local" })).toMatchObject({
      status: "published",
      generation: 1,
    });
    expect(await objectKeys()).toEqual([(await indexRow())?.objectKey]);
    expect(await publishedTitles("resilient")).toEqual(["Resilient"]);
  });

  it("reconciles an unknown publication outcome by reading its write id back", async () => {
    await writeTask(store, owner, { title: "Uncertain" });
    const unknown: DbClient = {
      ...store.db,
      batch: async (statements, options) => {
        const results = await store.db.batch(statements, options);
        if (statements.some((statement) => statement.sql.includes("INSERT INTO search_indexes"))) {
          throw new DbUnknownOutcomeError("timeout");
        }
        return results;
      },
      all: (statement, options) => store.db.all(statement, options),
      first: (statement, options) => store.db.first(statement, options),
      run: (statement, options) => store.db.run(statement, options),
    };
    expect(await writer({ db: unknown }).run(owner, { mode: "local" })).toMatchObject({
      status: "published",
      generation: 1,
    });
    expect(await publishedTitles("uncertain")).toEqual(["Uncertain"]);
  });

  it("writes only in its own executor mode and generation", async () => {
    await writeTask(store, owner, { title: "Guarded" });
    expect(await writer().run(owner, { mode: "durable" })).toEqual({
      status: "skipped",
      reason: "executor_mode",
    });
    expect(await writer().run(owner, { mode: "local", executorGeneration: 7 })).toEqual({
      status: "skipped",
      reason: "executor_generation",
    });
    await setExecutorMode(store, "durable", 3);
    expect(await writer().run(owner, { mode: "durable" })).toMatchObject({ status: "published" });
    expect(await objectKeys()).toHaveLength(1);
    expect(
      (await store.db.first(sql(`SELECT executor_generation FROM search_indexes`)))
        ?.executor_generation,
    ).toBe(3);
  });

  it("does not publish when the executor generation moves during the run", async () => {
    await writeTask(store, owner, { title: "Switched" });
    const switching: ObjectStore = {
      ...store.objects,
      get: (key) => store.objects.get(key),
      head: (key) => store.objects.head(key),
      list: (input) => store.objects.list(input),
      delete: (key) => store.objects.delete(key),
      put: async (input) => {
        const result = await store.objects.put(input);
        await store.db.run(
          sql(`UPDATE executor_state SET generation = generation + 1 WHERE id = 1`),
        );
        return result;
      },
    };
    expect(await writer({ objects: switching }).run(owner, { mode: "local" })).toEqual({
      status: "conflict",
    });
    expect(await indexRow()).toBeNull();
    expect(await objectKeys()).toEqual([]);
  });

  it("skips accounts being deleted or without a key", async () => {
    await writeTask(store, owner, { title: "Leaving" });
    await store.db.run(
      sql(
        `UPDATE users SET deletion_state = 'deleting', deletion_requested_at = :now WHERE id = :id`,
        {
          id: owner,
          now: int(store.now),
        },
      ),
    );
    expect(await writer().run(owner, { mode: "local" })).toEqual({
      status: "skipped",
      reason: "account_unavailable",
    });
    expect(await objectKeys()).toEqual([]);
  });

  it("rebuilds from authoritative records when the published object is corrupt or missing", async () => {
    await writeTask(store, owner, { title: "Keep me searchable" });
    await writer().run(owner, { mode: "local" });
    const row = await indexRow();
    const stored = await store.objects.get(row?.objectKey ?? "");
    const tampered = (stored?.body ?? new Uint8Array()).slice();
    tampered[tampered.length - 5] = (tampered[tampered.length - 5] as number) ^ 0xff;
    await store.objects.delete(row?.objectKey ?? "");
    await store.objects.put({ key: row?.objectKey ?? "", body: tampered });

    expect(await writer().run(owner, { mode: "local" })).toMatchObject({
      status: "published",
      generation: 2,
      rebuilt: true,
    });
    expect(events.some((event) => event.event === "search.index_unreadable")).toBe(true);
    expect(await publishedTitles("searchable")).toEqual(["Keep me searchable"]);

    await store.objects.delete((await indexRow())?.objectKey ?? "");
    expect(await writer().run(owner, { mode: "local" })).toMatchObject({
      generation: 3,
      rebuilt: true,
    });
    expect(await publishedTitles("searchable")).toEqual(["Keep me searchable"]);
  });

  it("rebuilds when the stored tokenizer fingerprint or format differs", async () => {
    await writeTask(store, owner, { title: "Fingerprinted" });
    await writer().run(owner, { mode: "local" });
    await store.db.run(
      sql(
        `UPDATE search_indexes SET tokenizer_fingerprint = 'symplist-tokenizer/0' WHERE owner_id = :owner`,
        {
          owner,
        },
      ),
    );
    expect(await writer().run(owner, { mode: "local" })).toMatchObject({
      generation: 2,
      rebuilt: true,
    });
    expect((await indexRow())?.tokenizerFingerprint).toBe(TOKENIZER_FINGERPRINT);
    await store.db.run(
      sql(`UPDATE search_indexes SET index_format_version = 99 WHERE owner_id = :owner`, { owner }),
    );
    expect(await writer().run(owner, { mode: "local" })).toMatchObject({
      generation: 3,
      rebuilt: true,
    });
  });

  it("includes chat messages only after the owner opts in, and removes them after opting out", async () => {
    const task = await writeTask(store, owner, { title: "Portfolio" });
    const conversationId = uuidv7(store.now);
    const messageId = uuidv7(store.now);
    store.messages.persist(owner, {
      id: messageId,
      taskId: task,
      conversationId,
      speaker: "user",
      createdAt: store.now,
      text: "which project images are missing",
    });
    await recordIntent(store, owner, "message", messageId);
    await writer().run(owner, { mode: "local" });
    expect(await publishedTitles("images", owner, ["chat"])).toEqual([]);

    store.chatOptIn.set(owner, true);
    expect(await writer().run(owner, { mode: "local" })).toMatchObject({ rebuilt: true });
    expect((await indexRow())?.includeChat).toBe(true);
    expect(await publishedTitles("images", owner, ["chat"])).toEqual(["Portfolio"]);

    store.chatOptIn.set(owner, false);
    expect(await writer().run(owner, { mode: "local" })).toMatchObject({ rebuilt: true });
    expect(await publishedTitles("images", owner, ["chat"])).toEqual([]);
  });

  it("keeps two owners' indexes, intents and objects apart", async () => {
    const other = await insertOwner(store, "other@example.test");
    await writeTask(store, owner, { title: "Maya invoice" });
    await writeTask(store, other, { title: "Other invoice" });
    await writer().run(owner, { mode: "local" });
    expect(await publishedTitles("invoice")).toEqual(["Maya invoice"]);
    expect(await countRows(store, "search_intents", other)).toBe(1);
    expect(await indexRow(other)).toBeNull();
    await writer().run(other, { mode: "local" });
    expect(await publishedTitles("invoice", other)).toEqual(["Other invoice"]);
    // One owner's object never opens with the other's key.
    const row = await indexRow(owner);
    const stored = await store.objects.get(row?.objectKey ?? "");
    const otherKey = await ownerKey(store, other);
    expect(() =>
      openSearchIndex(otherKey, stored?.body ?? new Uint8Array(), {
        ownerId: other,
        generation: row?.generation ?? 0,
        writeId: row?.writeId ?? "",
      }),
    ).toThrow();
  });

  it("never reads Vault data into the index", async () => {
    const marker = "vault-marker-7f3a9c";
    await store.db.executeScript(
      `CREATE TABLE vault_items (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, value TEXT NOT NULL) STRICT;`,
    );
    await store.db.run(
      sql(`INSERT INTO vault_items (id, owner_id, value) VALUES (:id, :owner, :value)`, {
        id: uuidv7(store.now),
        owner,
        value: marker,
      }),
    );
    await writeTask(store, owner, { title: "Ordinary task" });
    await writer().run(owner, { mode: "local" });
    const row = await indexRow();
    const stored = await store.objects.get(row?.objectKey ?? "");
    const key = await ownerKey(store, owner);
    const plaintext = decryptObject(
      key,
      {
        kind: SEARCH_INDEX_OBJECT_KIND,
        ownerId: owner,
        objectId: `1-${row?.writeId}`,
        formatVersion: 1,
      },
      stored?.body ?? new Uint8Array(),
    );
    expect(Buffer.from(plaintext).toString("utf8")).not.toContain(marker);
    expect(Buffer.from(plaintext).toString("utf8")).toContain("Ordinary task");

    const searchDir = fileURLToPath(new URL(".", import.meta.url));
    const sources = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return /\.ts$/.test(name) && !/\.test(?:-support)?\.ts$/.test(name) ? [path] : [];
      });
    })(searchDir);
    const offending = sources.filter((path) => /vault/i.test(readFileSync(path, "utf8")));
    expect(offending.map((path) => relative(searchDir, path))).toEqual([]);
  });
});
