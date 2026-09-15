import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountDataKey,
  createKeyProvider,
  encryptFieldText,
  keyFamilies,
  type ManagedKeyProvider,
} from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { createLocalObjectStore, type LocalObjectStore } from "@symplist/storage";
import { AccountKeyStore } from "../account/keys.ts";
import { type SearchIntentEntity, type SearchIntentOp, searchIntentStatement } from "./intents.ts";
import {
  InMemoryChatOptInSource,
  InMemoryDeadlineFilterSource,
  InMemoryDocumentTextSource,
  InMemoryMessageTextSource,
} from "./sources/memory.ts";
import { D1SearchTaskSource, taskTitleContext } from "./sources/tasks.ts";
import type { SearchSources } from "./sources/types.ts";

/**
 * Test support for `core/search` (not exported from the package): a migrated `node:sqlite` database,
 * a local object store, generated keys, users with account keys, encrypted task rows, intents and the
 * in-memory sources of the features search reads from.
 */
export interface SearchTestStore {
  readonly db: LocalSqliteClient;
  readonly objects: LocalObjectStore;
  readonly keys: ManagedKeyProvider;
  readonly accountKeys: AccountKeyStore;
  readonly documents: InMemoryDocumentTextSource;
  readonly messages: InMemoryMessageTextSource;
  readonly chatOptIn: InMemoryChatOptInSource;
  readonly deadlines: InMemoryDeadlineFilterSource;
  readonly deadlineMatches: Map<string, Set<string>>;
  readonly sources: SearchSources;
  now: number;
  close(): void;
}

export async function createSearchTestStore(): Promise<SearchTestStore> {
  const db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  const dir = mkdtempSync(join(tmpdir(), "symplist-search-"));
  const objects = createLocalObjectStore({ root: dir, env: { NODE_ENV: "test" } });
  const keys = createKeyProvider(
    Object.fromEntries(
      keyFamilies.map((family) => [
        family,
        { current: 1, versions: new Map([[1, randomBytes(32)]]) },
      ]),
    ),
  );
  const documents = new InMemoryDocumentTextSource();
  const messages = new InMemoryMessageTextSource();
  const chatOptIn = new InMemoryChatOptInSource();
  const deadlineMatches = new Map<string, Set<string>>();
  const deadlines = new InMemoryDeadlineFilterSource(
    (ownerId) => deadlineMatches.get(ownerId) ?? new Set(),
  );
  const store: SearchTestStore = {
    db,
    objects,
    keys,
    accountKeys: new AccountKeyStore({ db, keys }),
    documents,
    messages,
    chatOptIn,
    deadlines,
    deadlineMatches,
    sources: {
      tasks: new D1SearchTaskSource(db),
      documents,
      messages,
      chatOptIn,
      deadlines,
    },
    now: 1_789_500_000_000,
    close() {
      db.close();
      keys.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  await db.run(
    sql(`UPDATE executor_state SET mode = 'local', updated_at = :now WHERE id = 1`, {
      now: int(store.now),
    }),
  );
  return store;
}

export async function setExecutorMode(
  store: SearchTestStore,
  mode: "local" | "durable",
  generation?: number,
): Promise<void> {
  await store.db.run(
    sql(
      `UPDATE executor_state SET mode = :mode, generation = COALESCE(:generation, generation), updated_at = :now
       WHERE id = 1`,
      {
        mode,
        generation: generation === undefined ? null : int(generation),
        now: int(store.now),
      },
    ),
  );
}

/** Inserts a verified, unlocked user with an account key and returns the id. */
export async function insertOwner(
  store: SearchTestStore,
  email: string,
  id?: string,
): Promise<string> {
  const userId = id ?? uuidv7(store.now);
  await store.db.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, 'unlocked', :now, :now, :w)`,
      { id: userId, email, now: int(store.now), w: uuidv7(store.now) },
    ),
    store.accountKeys.provisionStatement({ userId, now: store.now }),
  ]);
  return userId;
}

export async function ownerKey(store: SearchTestStore, ownerId: string): Promise<AccountDataKey> {
  return store.accountKeys.require(ownerId);
}

export interface TaskRowInput {
  readonly id?: string;
  readonly title: string;
  readonly collection?: "now" | "later" | "unclassified";
  readonly parentId?: string | null;
  readonly archived?: boolean;
  readonly version?: number;
  readonly updatedAt?: number;
}

/** Inserts or replaces a task row with an encrypted title, and records a task intent. */
export async function writeTask(
  store: SearchTestStore,
  ownerId: string,
  input: TaskRowInput,
  options: { readonly intent?: boolean } = {},
): Promise<string> {
  const id = input.id ?? uuidv7(store.now);
  const key = await ownerKey(store, ownerId);
  const titleEnc = encryptFieldText(key, taskTitleContext(ownerId, id), input.title);
  const archived = input.archived === true;
  const version = input.version ?? 1;
  const statements = [
    sql(
      `INSERT INTO tasks (id, owner_id, parent_id, collection, position, status, archived_at,
         source, version, write_id, title_enc, created_at, updated_at)
       VALUES (:id, :owner, :parent, :collection, 'a0', :status, :archived_at, 'user', :version, :w,
         :title, :now, :updated)
       ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, collection = excluded.collection,
         status = excluded.status, archived_at = excluded.archived_at, version = excluded.version,
         write_id = excluded.write_id, title_enc = excluded.title_enc, updated_at = excluded.updated_at`,
      {
        id,
        owner: ownerId,
        parent: input.parentId ?? null,
        collection: input.collection ?? "now",
        status: archived ? "archived" : "active",
        archived_at: archived ? int(store.now) : null,
        version: int(version),
        w: uuidv7(store.now),
        title: titleEnc,
        now: int(store.now),
        updated: int(input.updatedAt ?? store.now),
      },
    ),
  ];
  if (options.intent !== false) {
    statements.push(
      searchIntentStatement({
        ownerId,
        entity: "task",
        entityId: id,
        revisionOrSeq: version,
        op: "upsert",
        now: store.now,
      }),
    );
  }
  await store.db.batch(statements);
  return id;
}

export async function recordIntent(
  store: SearchTestStore,
  ownerId: string,
  entity: SearchIntentEntity,
  entityId: string,
  op: SearchIntentOp = "upsert",
  revisionOrSeq = 1,
): Promise<void> {
  await store.db.run(
    searchIntentStatement({ ownerId, entity, entityId, revisionOrSeq, op, now: store.now }),
  );
}

export async function countRows(
  store: SearchTestStore,
  table: "search_intents" | "search_indexes",
  ownerId: string,
): Promise<number> {
  const row = await store.db.first(
    sql(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_id = :owner`, { owner: ownerId }),
  );
  return Number(row?.count ?? 0);
}
