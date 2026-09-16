import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountKeyStore } from "@symplist/core/account";
import {
  D1SearchTaskSource,
  SEARCH_INDEX_PUBLISHED_EVENT,
  type SearchSources,
  searchIntentStatement,
  taskTitleContext,
} from "@symplist/core/search";
import {
  createKeyProvider,
  encryptFieldText,
  keyFamilies,
  type ManagedKeyProvider,
  zeroize,
} from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import {
  createLocalObjectStore,
  type LocalObjectStore,
  type ObjectStore,
  StorageError,
} from "@symplist/storage";
import { findMarkerIn } from "@symplist/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerError } from "../../infra/errors.ts";
import { createWorkerLogger } from "../../infra/logger.ts";
import { runSearchIndexTask, type SearchIndexTaskDependencies } from "./run-search-index.ts";

const MARKER = "MARKER-search-index-6c1f";
const now = 1_789_500_000_000;

let db: LocalSqliteClient;
let objects: LocalObjectStore;
let keys: ManagedKeyProvider;
let dir: string;
let owner: string;
const logLines: string[] = [];
const announced: unknown[] = [];
const enqueued: string[] = [];

function dependencies(
  overrides: Partial<SearchIndexTaskDependencies> = {},
): SearchIndexTaskDependencies {
  const sources: SearchSources = {
    tasks: new D1SearchTaskSource(db),
    documents: null,
    messages: null,
    chatOptIn: null,
    deadlines: null,
  };
  return {
    db,
    objects,
    keys,
    sources,
    logger: createWorkerLogger({
      info: (message, properties) => logLines.push(JSON.stringify({ message, properties })),
      warn: (message, properties) => logLines.push(JSON.stringify({ message, properties })),
      error: (message, properties) => logLines.push(JSON.stringify({ message, properties })),
    }),
    announce: async (input) => {
      announced.push(input);
      return "delivered";
    },
    enqueue: async (ownerId) => {
      enqueued.push(ownerId);
    },
    timers: { now: () => now, setTimeout: () => undefined, clearTimeout: () => undefined },
    ...overrides,
  };
}

async function addTask(title: string): Promise<string> {
  const id = uuidv7(now);
  const key = await new AccountKeyStore({ db, keys }).require(owner);
  const titleEnc = encryptFieldText(key, taskTitleContext(owner, id), title);
  zeroize(key.key);
  await db.batch([
    sql(
      `INSERT INTO tasks (id, owner_id, collection, position, source, title_enc, created_at, updated_at, write_id)
       VALUES (:id, :owner, 'now', 'a0', 'user', :title, :now, :now, 'w')`,
      { id, owner, title: titleEnc, now: int(now) },
    ),
    searchIntentStatement({
      ownerId: owner,
      entity: "task",
      entityId: id,
      revisionOrSeq: 1,
      op: "upsert",
      now,
    }),
  ]);
  return id;
}

beforeEach(async () => {
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  dir = mkdtempSync(join(tmpdir(), "symplist-worker-search-"));
  objects = createLocalObjectStore({ root: dir, env: { NODE_ENV: "test" } });
  keys = createKeyProvider(
    Object.fromEntries(
      keyFamilies.map((family) => [
        family,
        { current: 1, versions: new Map([[1, randomBytes(32)]]) },
      ]),
    ),
  );
  owner = uuidv7(now);
  await db.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, created_at, updated_at, write_id)
       VALUES (:id, 'maya@example.test', :now, 'unlocked', :now, :now, 'w')`,
      { id: owner, now: int(now) },
    ),
    new AccountKeyStore({ db, keys }).provisionStatement({ userId: owner, now }),
    sql(`UPDATE executor_state SET mode = 'durable' WHERE id = 1`),
  ]);
  logLines.length = 0;
  announced.length = 0;
  enqueued.length = 0;
});

afterEach(() => {
  db.close();
  keys.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe("runSearchIndexTask (§8.8, §10.1)", () => {
  it("publishes the owner's index in durable mode and announces ids and counts only", async () => {
    await addTask(`Quarterly plan ${MARKER}`);
    const output = await runSearchIndexTask({ ownerId: owner }, dependencies());
    expect(output).toEqual({ status: "published", generation: 1, pendingCount: 0, batchCount: 1 });
    expect(announced).toEqual([
      {
        type: SEARCH_INDEX_PUBLISHED_EVENT,
        ownerId: owner,
        payload: { generation: 1, pending: 0 },
      },
    ]);
    const row = await db.first(
      sql(`SELECT generation, object_key FROM search_indexes WHERE owner_id = :owner`, { owner }),
    );
    expect(row?.generation).toBe(1);
    const stored = await objects.get(String(row?.object_key));
    // The marker lives only inside the encrypted object: never in logs, announcements or the output.
    expect(Buffer.from(stored?.body ?? []).toString("latin1")).not.toContain(MARKER);
    expect(findMarkerIn([logLines, announced, output], MARKER)).toEqual([]);
    expect(await runSearchIndexTask({ ownerId: owner }, dependencies())).toEqual({
      status: "up_to_date",
      generation: 1,
      pendingCount: 0,
      batchCount: 1,
    });
  });

  it("writes nothing once durable mode has ended", async () => {
    await addTask("Switched away");
    await db.run(
      sql(`UPDATE executor_state SET mode = 'local', generation = generation + 1 WHERE id = 1`),
    );
    const output = await runSearchIndexTask({ ownerId: owner }, dependencies());
    expect(output).toMatchObject({ status: "skipped" });
    expect(announced).toEqual([]);
    expect(await db.first(sql(`SELECT COUNT(*) AS count FROM search_indexes`))).toEqual({
      count: 0,
    });
    expect((await objects.list({ prefix: "u/" })).objects).toEqual([]);
  });

  it("enqueues the next window when its batch budget ends with changes pending", async () => {
    for (let index = 0; index < 3; index += 1) await addTask(`Task ${index}`);
    await runSearchIndexTask({ ownerId: owner }, dependencies());
    for (let index = 0; index < 3; index += 1) await addTask(`Later ${index}`);
    const output = await runSearchIndexTask(
      { ownerId: owner },
      dependencies({ batchLimit: 1, maxBatches: 2 }),
    );
    expect(output).toEqual({ status: "incomplete", generation: 3, pendingCount: 1, batchCount: 2 });
    expect(enqueued).toEqual([owner]);
    expect(announced).toHaveLength(3);
  });

  it("maps storage outages to retryable stable codes and bad payloads to permanent ones", async () => {
    await addTask(`Unavailable ${MARKER}`);
    const broken: ObjectStore = {
      get: (key) => objects.get(key),
      head: (key) => objects.head(key),
      list: (input) => objects.list(input),
      delete: (key) => objects.delete(key),
      put: async () => {
        throw new StorageError("storage.unavailable", `upstream said ${MARKER}`);
      },
    };
    const failure = await runSearchIndexTask(
      { ownerId: owner },
      dependencies({ objects: broken }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkerError);
    expect(failure).toMatchObject({
      code: "storage.unavailable",
      retryable: true,
      message: "storage.unavailable",
    });
    expect(
      findMarkerIn(
        [String(failure), (failure as Error).message, (failure as Error).stack, logLines],
        MARKER,
      ),
    ).toEqual([]);

    for (const payload of [null, {}, { ownerId: "not-an-id" }, { ownerId: owner, title: MARKER }]) {
      await expect(runSearchIndexTask(payload, dependencies())).rejects.toMatchObject({
        code: "search_index.payload_invalid",
        retryable: false,
      });
    }
  });

  it("stops between batches when the run is aborted", async () => {
    await addTask("Aborted");
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSearchIndexTask({ ownerId: owner }, dependencies(), controller.signal),
    ).rejects.toMatchObject({
      code: "run.aborted",
    });
    expect(announced).toEqual([]);
  });
});
