import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createKeyProvider,
  encryptFieldText,
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
import { CiphertextCache, GitService } from "@symplist/docs";
import { createLocalObjectStore, type LocalObjectStore } from "@symplist/storage";
import { AccountKeyStore } from "../account/keys.ts";
import { taskTitleContext } from "../tasks/sql.ts";
import type { DocumentActor, McpDocumentActor, SimonDocumentActor } from "./actor.ts";
import type { DocumentHeadChanged } from "./events.ts";
import { DocumentRepository, type DocumentRepositoryOptions } from "./repository.ts";
import { DocumentService } from "./service.ts";
import { DocumentTools } from "./tools.ts";

/** Test support for the documents domain (not exported from the package). */
export interface DocumentsTestEnvironment {
  readonly dir: string;
  readonly db: LocalSqliteClient;
  readonly objects: LocalObjectStore;
  readonly keys: ManagedKeyProvider;
  readonly git: GitService;
  readonly repository: DocumentRepository;
  readonly service: DocumentService;
  readonly tools: DocumentTools;
  readonly events: DocumentHeadChanged[];
  clock: number;
  createUser(state?: "admitted" | "relocked" | "locked"): Promise<string>;
  createTask(ownerId: string): Promise<string>;
  archiveTask(taskId: string): Promise<void>;
  relock(userId: string): Promise<void>;
  user(userId: string): { readonly kind: "user"; readonly userId: string };
  simon(
    userId: string,
    taskId: string | null,
    overrides?: Partial<SimonDocumentActor>,
  ): SimonDocumentActor;
  mcp(userId: string, overrides?: Partial<McpDocumentActor>): McpDocumentActor;
  count(table: string): Promise<number>;
  close(): Promise<void>;
}

let sequence = 0;

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

export async function createDocumentsTestEnvironment(
  options: { readonly repository?: Partial<DocumentRepositoryOptions> } = {},
): Promise<DocumentsTestEnvironment> {
  const dir = mkdtempSync(join(tmpdir(), "symplist-core-docs-"));
  const db = createLocalSqliteClient({ path: join(dir, "d1.sqlite"), env: {} });
  await applyMigrations(db);
  const objects = createLocalObjectStore({ root: join(dir, "objects"), env: {} });
  const keys = createKeyProvider(
    { CONTENT_KEK: { current: 1, versions: new Map([[1, randomBytes(32)]]) } },
    { required: ["CONTENT_KEK"] },
  );
  const git = new GitService({ tempDir: join(dir, "git") });
  const events: DocumentHeadChanged[] = [];
  const accountKeys = new AccountKeyStore({ db, keys });
  const environment: DocumentsTestEnvironment = {
    dir,
    db,
    objects,
    keys,
    git,
    events,
    clock: Date.UTC(2026, 8, 15, 9, 0, 0),
    repository: undefined as never,
    service: undefined as never,
    tools: undefined as never,
    async createUser(state = "admitted") {
      sequence += 1;
      const id = uuidv7(environment.clock);
      await db.batch([
        sql(
          `INSERT INTO users (id, email, email_verified_at, beta_state, onboarding_step, created_at, updated_at, write_id)
           VALUES (:id, :email, :now, :beta, 'done', :now, :now, :w)`,
          {
            id,
            email: `docs${sequence}.${id.slice(-6)}@example.test`,
            now: int(environment.clock),
            beta: state === "admitted" ? "unlocked" : state,
            w: uuidv7(environment.clock),
          },
        ),
        accountKeys.provisionStatement({ userId: id, now: environment.clock }),
      ]);
      return id;
    },
    async createTask(ownerId) {
      const id = uuidv7(environment.clock);
      const key = await accountKeys.require(ownerId);
      let title: string;
      try {
        title = encryptFieldText(key, taskTitleContext(ownerId, id), "Test task");
      } finally {
        zeroize(key.key);
      }
      await db.run(
        sql(
          `INSERT INTO tasks (id, owner_id, collection, position, source, write_id, title_enc, created_at, updated_at)
           VALUES (:id, :owner, 'now', 'a0', 'user', :w, :title, :now, :now)`,
          { id, owner: ownerId, title, w: uuidv7(environment.clock), now: int(environment.clock) },
        ),
      );
      return id;
    },
    async archiveTask(taskId) {
      await db.run(
        sql(
          `UPDATE tasks SET status = 'archived', archived_at = :now, archived_with_root_id = id, write_id = :w WHERE id = :id`,
          { now: int(environment.clock), w: uuidv7(environment.clock), id: taskId },
        ),
      );
    },
    async relock(userId) {
      await db.run(
        sql(
          `UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1 WHERE id = :id`,
          {
            id: userId,
          },
        ),
      );
    },
    user: (userId) => ({ kind: "user", userId }),
    simon: (userId, taskId, overrides = {}) => ({
      kind: "simon",
      userId,
      conversationId: "0192f0a0-0000-7000-8000-000000000501",
      runId: "0192f0a0-0000-7000-8000-000000000601",
      toolCallId: `call_${nextSequence()}`,
      contextEpoch: 0,
      mode: "task",
      taskId,
      ...overrides,
    }),
    mcp: (userId, overrides = {}) => ({
      kind: "mcp",
      userId,
      grantId: "0192f0a0-0000-7000-8000-000000000901",
      scopes: ["tasks:read", "tasks:write"],
      taskIds: null,
      requestId: `mcp-${nextSequence()}`,
      ...overrides,
    }),
    async count(table) {
      const row = await db.first(sql(`SELECT COUNT(*) AS n FROM ${table}`));
      return row?.n as number;
    },
    async close() {
      db.close();
      keys.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  const repository = new DocumentRepository({
    db,
    objects,
    keys,
    git,
    accessPolicy: { betaAccessRequired: true },
    now: () => environment.clock,
    docMaxBytes: 1_048_576,
    cache: new CiphertextCache(0),
    events: {
      headChanged: async (event) => {
        events.push(event);
      },
    },
    ...options.repository,
  });
  Object.assign(environment, {
    repository,
    service: new DocumentService(repository),
    tools: new DocumentTools(repository),
  });
  return environment;
}

export type { DocumentActor };
