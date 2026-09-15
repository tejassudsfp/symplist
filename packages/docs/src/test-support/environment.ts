import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountDataKey,
  createAccountKey,
  createKeyProvider,
  type ManagedKeyProvider,
  unwrapAccountKey,
  zeroize,
} from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  type DbClient,
  int,
  type LocalSqliteClient,
  type StatementResult,
  sql,
  uuidv7,
} from "@symplist/db";
import { createLocalObjectStore, type LocalObjectStore } from "@symplist/storage";
import { CiphertextCache, DocumentArtifacts } from "../artifacts/store.ts";
import { DocumentError } from "../errors.ts";
import { GitService } from "../git/service.ts";
import {
  DocumentPublisher,
  type DocumentPublisherOptions,
  type PublicationContext,
} from "../publication/publisher.ts";

/**
 * Test support for `@symplist/docs` (excluded from the build): local `node:sqlite` with every
 * migration, the local object store, real Git in a private temp root, and users, tasks and account
 * keys created the way the platform creates them.
 */
export interface DocsTestEnvironment {
  readonly dir: string;
  readonly db: LocalSqliteClient;
  readonly objects: LocalObjectStore;
  readonly keys: ManagedKeyProvider;
  readonly git: GitService;
  /** Artifacts without a ciphertext cache, so every read goes to the store. */
  readonly artifacts: DocumentArtifacts;
  now: number;
  createUser(): Promise<string>;
  createTask(
    ownerId: string,
    options?: { readonly status?: "active" | "archived" },
  ): Promise<string>;
  archiveTask(ownerId: string, taskId: string): Promise<void>;
  accountKey(ownerId: string): Promise<AccountDataKey>;
  /** A context that requires the task to exist for the owner and, for writes, to be active. */
  context(ownerId: string, taskId: string): PublicationContext;
  publisher(options?: Partial<DocumentPublisherOptions>): DocumentPublisher;
  close(): Promise<void>;
}

export async function createDocsTestEnvironment(
  options: { readonly db?: (db: LocalSqliteClient) => DbClient } = {},
): Promise<DocsTestEnvironment> {
  const dir = mkdtempSync(join(tmpdir(), "symplist-docs-test-"));
  const db = createLocalSqliteClient({ path: join(dir, "d1.sqlite"), env: {} });
  await applyMigrations(db);
  const objects = createLocalObjectStore({ root: join(dir, "objects"), env: {} });
  const keys = createKeyProvider(
    { CONTENT_KEK: { current: 1, versions: new Map([[1, randomBytes(32)]]) } },
    { required: ["CONTENT_KEK"] },
  );
  const git = new GitService({ tempDir: join(dir, "git-tmp") });
  const artifacts = new DocumentArtifacts({ objects, cache: new CiphertextCache(0) });
  const client = options.db ? options.db(db) : db;

  const environment: DocsTestEnvironment = {
    dir,
    db,
    objects,
    keys,
    git,
    artifacts,
    now: Date.UTC(2026, 8, 15, 9, 0, 0),
    async createUser() {
      const id = uuidv7(environment.now);
      const created = createAccountKey(keys, id);
      zeroize(created.key.key);
      await db.batch([
        sql(
          `INSERT INTO users (id, email, email_verified_at, beta_state, onboarding_step, created_at, updated_at, write_id)
           VALUES (:id, :email, :now, 'unlocked', 'done', :now, :now, :w)`,
          {
            id,
            email: `${id}@example.test`,
            now: int(environment.now),
            w: uuidv7(environment.now),
          },
        ),
        sql(
          `INSERT INTO account_keys (owner_id, kek_version, wrapped_key, created_at, updated_at, write_id)
           VALUES (:owner, :kek, :wrapped, :now, :now, :w)`,
          {
            owner: id,
            kek: int(created.wrapped.kekVersion),
            wrapped: created.wrapped.wrapped,
            now: int(environment.now),
            w: uuidv7(environment.now),
          },
        ),
      ]);
      return id;
    },
    async createTask(ownerId, taskOptions = {}) {
      const id = uuidv7(environment.now);
      const archived = taskOptions.status === "archived";
      await db.run(
        sql(
          `INSERT INTO tasks (id, owner_id, parent_id, collection, position, status, archived_at,
             archived_with_root_id, source, write_id, title_enc, created_at, updated_at)
           VALUES (:id, :owner, NULL, 'now', 'a0', :status, :archived_at, :root, 'user', :w, 'sym1.1.x.y', :now, :now)`,
          {
            id,
            owner: ownerId,
            status: archived ? "archived" : "active",
            archived_at: archived ? int(environment.now) : null,
            root: archived ? id : null,
            w: uuidv7(environment.now),
            now: int(environment.now),
          },
        ),
      );
      return id;
    },
    async archiveTask(ownerId, taskId) {
      await db.run(
        sql(
          `UPDATE tasks SET status = 'archived', archived_at = :now, archived_with_root_id = id, write_id = :w
           WHERE id = :id AND owner_id = :owner`,
          { now: int(environment.now), w: uuidv7(environment.now), id: taskId, owner: ownerId },
        ),
      );
    },
    async accountKey(ownerId) {
      const row = await db.first(
        sql(`SELECT owner_id, kek_version, wrapped_key FROM account_keys WHERE owner_id = :owner`, {
          owner: ownerId,
        }),
      );
      if (!row) throw new Error("No account key");
      return unwrapAccountKey(keys, {
        ownerId: row.owner_id as string,
        kekVersion: row.kek_version as number,
        wrapped: row.wrapped_key as string,
      });
    },
    context(ownerId, taskId) {
      return {
        statements: [
          sql(`SELECT status FROM tasks WHERE id = :task AND owner_id = :owner`, {
            task: taskId,
            owner: ownerId,
          }),
          sql(
            `SELECT owner_id, kek_version, wrapped_key FROM account_keys WHERE owner_id = :owner`,
            {
              owner: ownerId,
            },
          ),
        ],
        verify(results: readonly StatementResult[]) {
          const task = results[0]?.results[0];
          if (!task) throw new DocumentError("not_found");
          if (task.status !== "active") throw new DocumentError("task.archived");
          const key = results[1]?.results[0];
          if (!key) throw new DocumentError("not_found");
          return unwrapAccountKey(keys, {
            ownerId: key.owner_id as string,
            kekVersion: key.kek_version as number,
            wrapped: key.wrapped_key as string,
          });
        },
        guards: [
          {
            sql: "EXISTS (SELECT 1 FROM tasks WHERE id = :guard_task AND owner_id = :guard_owner AND status = 'active')",
            params: { guard_task: taskId, guard_owner: ownerId },
          },
        ],
      };
    },
    publisher(publisherOptions = {}) {
      return new DocumentPublisher({ db: client, git, artifacts, ...publisherOptions });
    },
    async close() {
      db.close();
      keys.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return environment;
}
