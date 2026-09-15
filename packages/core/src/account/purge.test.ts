import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyProvider, keyFamilies, type ManagedKeyProvider } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { createLocalObjectStore, type LocalObjectStore } from "@symplist/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1AccessService } from "../access/restrict.ts";
import { SessionStore } from "../access/sessions.ts";
import { AccountDeletionService, accountObjectPrefix } from "./deletion.ts";
import { AccountKeyStore } from "./keys.ts";
import {
  type AccountPurgeExternalStep,
  AccountPurgeRunner,
  PurgeContributorError,
} from "./purge.ts";
import { accountPurgeContributor } from "./purge-contributors/account.ts";
import { idempotencyPurgeContributor } from "./purge-contributors/idempotency.ts";
import type { PurgeContributor } from "./purge-contributors/types.ts";

const now = 1_789_500_000_000;
let db: LocalSqliteClient;
let keys: ManagedKeyProvider;
let store: LocalObjectStore;
let dir: string;

/** Probe rows owned by the user, standing in for a feature domain's children. */
const probeContributor: PurgeContributor = {
  domain: "simon",
  statements: ({ userId, batchLimit }) => [
    sql(
      `DELETE FROM probe_rows WHERE rowid IN (
         SELECT rowid FROM probe_rows WHERE owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
      { user: userId, limit: int(batchLimit) },
    ),
  ],
  remaining: ({ userId }) => [
    sql(`SELECT EXISTS (SELECT 1 FROM probe_rows WHERE owner_id = :user) AS remaining`, {
      user: userId,
    }),
  ],
};

const tasksContributor: PurgeContributor = {
  domain: "tasks",
  statements: ({ userId }) => [sql(`DELETE FROM tasks WHERE owner_id = :user`, { user: userId })],
  remaining: ({ userId }) => [
    sql(`SELECT EXISTS (SELECT 1 FROM tasks WHERE owner_id = :user) AS remaining`, {
      user: userId,
    }),
  ],
};

const done: AccountPurgeExternalStep = { run: async () => "done" };

async function insertUser(email: string): Promise<string> {
  const id = uuidv7(now);
  await db.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, :now, :now, :w)`,
      { id, email, now: int(now), w: uuidv7(now) },
    ),
    new AccountKeyStore({ db, keys }).provisionStatement({ userId: id, now }),
  ]);
  return id;
}

async function deletedAccount(probeRows = 3): Promise<{ userId: string; other: string }> {
  const userId = await insertUser("purged@example.test");
  const other = await insertUser("kept@example.test");
  const sessions = new SessionStore({ db, keys });
  const session = await sessions.create({ userId, now });
  await sessions.create({ userId: other, now });
  if (!session) throw new Error("expected a session");
  const challengeId = uuidv7(now);
  const authorizationId = uuidv7(now);
  const statements = [
    sql(
      `INSERT INTO otp_challenges (id, user_id, purpose, auth_session_id, code_digest, digest_version,
         created_at, expires_at, consumed_at, write_id)
       VALUES (:id, :user, 'account_delete', :session, 'd', 1, :now, :exp, :now, 'w')`,
      {
        id: challengeId,
        user: userId,
        session: session.sessionId,
        now: int(now),
        exp: int(now + 600_000),
      },
    ),
    sql(
      `INSERT INTO account_delete_authorizations (id, user_id, auth_session_id, challenge_id, created_at,
         expires_at, consumed_at, write_id)
       VALUES (:id, :user, :session, :challenge, :now, :exp, NULL, 'w')`,
      {
        id: authorizationId,
        user: userId,
        session: session.sessionId,
        challenge: challengeId,
        now: int(now),
        exp: int(now + 600_000),
      },
    ),
    sql(
      `INSERT INTO idempotency_records (scope, user_id, key, fingerprint, fingerprint_version, status,
         created_at, updated_at, expires_at, write_id)
       VALUES ('POST /v1/x', :user, 'key-aaaaaaaaaaaaaaaa', 'f', 1, 'pending', :now, :now, :exp, 'w')`,
      { user: userId, now: int(now), exp: int(now + 1000) },
    ),
    sql(
      `INSERT INTO tasks (id, owner_id, collection, position, source, title_enc, created_at, updated_at, write_id)
       VALUES (:id, :user, 'now', 'a', 'user', 'sym1.x', :now, :now, 'w')`,
      { id: uuidv7(now), user: userId, now: int(now) },
    ),
    sql(
      `INSERT INTO abuse_counters (scope, subject, window_start, count, expires_at, updated_at, write_id)
       VALUES ('probe.scope', :user, :now, 1, :now, :now, 'w')`,
      { user: userId, now: int(now) },
    ),
  ];
  for (let index = 0; index < probeRows; index += 1) {
    statements.push(sql(`INSERT INTO probe_rows (owner_id) VALUES (:user)`, { user: userId }));
  }
  statements.push(sql(`INSERT INTO probe_rows (owner_id) VALUES (:user)`, { user: other }));
  await db.batch(statements);

  for (const key of ["docs/t1/c1.md.sym", "docs/t1/c2.md.sym", "search/1-w.idx"]) {
    await store.put({
      key: `${accountObjectPrefix(userId)}${key}`,
      body: new Uint8Array([1, 2, 3]),
    });
  }
  await store.put({
    key: `${accountObjectPrefix(other)}docs/keep.md.sym`,
    body: new Uint8Array([4]),
  });

  const access = new D1AccessService({
    db,
    policy: { betaAccessRequired: true },
    contributors: [],
  });
  const result = await new AccountDeletionService({ db, keys, access, sessions }).delete({
    userId,
    authorizationId,
    authSessionId: session.sessionId,
    now: now + 10,
  });
  expect(result.status).toBe("deleted");
  return { userId, other };
}

function runner(overrides: Partial<ConstructorParameters<typeof AccountPurgeRunner>[0]> = {}) {
  return new AccountPurgeRunner({
    db,
    store,
    now: () => now + 100,
    runs: done,
    composio: done,
    contributors: [
      probeContributor,
      tasksContributor,
      idempotencyPurgeContributor,
      accountPurgeContributor,
    ],
    ...overrides,
  });
}

beforeEach(async () => {
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  await db.executeScript(`CREATE TABLE probe_rows (owner_id TEXT NOT NULL) STRICT;`);
  keys = createKeyProvider(
    Object.fromEntries(
      keyFamilies.map((family) => [
        family,
        { current: 1, versions: new Map([[1, randomBytes(32)]]) },
      ]),
    ),
  );
  dir = mkdtempSync(join(tmpdir(), "symplist-purge-"));
  store = createLocalObjectStore({ root: dir, env: { NODE_ENV: "test" } });
});

afterEach(() => {
  db.close();
  keys.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe("account purge (§5.6)", () => {
  it("runs every step once, deletes only the account's data and leaves a tombstone", async () => {
    const { userId, other } = await deletedAccount();
    const runs = vi.fn(async () => "done" as const);
    const composio = vi.fn(async () => "done" as const);
    const digest = await db.first(
      sql(`SELECT email_digest, email_digest_version FROM account_deletions`),
    );

    expect(await runner({ runs: { run: runs }, composio: { run: composio } }).run(userId)).toEqual({
      status: "done",
    });
    expect(runs).toHaveBeenCalledWith({ userId, composioUserId: userId });
    expect(composio).toHaveBeenCalledTimes(1);

    expect(await db.first(sql(`SELECT id FROM users WHERE id = :id`, { id: userId }))).toBeNull();
    expect(
      await db.first(sql(`SELECT id FROM users WHERE id = :id`, { id: other })),
    ).not.toBeNull();
    expect(await db.first(sql(`SELECT * FROM account_tombstones`))).toEqual({
      user_id: userId,
      email_digest: digest?.email_digest,
      digest_version: digest?.email_digest_version,
      deleted_at: now + 100,
    });
    const deletion = await db.first(
      sql(`SELECT status, steps_done, completed_at FROM account_deletions`),
    );
    expect(deletion).toEqual({
      status: "done",
      steps_done: JSON.stringify([
        "runs",
        "composio",
        "r2",
        "d1:simon",
        "d1:tasks",
        "d1:idempotency",
        "d1:account",
        "d1",
        "users",
      ]),
      completed_at: now + 100,
    });
    for (const table of [
      "auth_sessions",
      "otp_challenges",
      "account_delete_authorizations",
      "idempotency_records",
      "tasks",
      "abuse_counters",
    ]) {
      const rows = await db.all(
        sql(
          `SELECT * FROM ${table} WHERE ${table === "tasks" ? "owner_id" : table === "abuse_counters" ? "subject" : "user_id"} = :id`,
          { id: userId },
        ),
      );
      expect(rows, table).toEqual([]);
    }
    expect(await db.all(sql(`SELECT owner_id FROM probe_rows`))).toEqual([{ owner_id: other }]);
    expect((await store.list({ prefix: accountObjectPrefix(userId) })).objects).toEqual([]);
    expect((await store.list({ prefix: accountObjectPrefix(other) })).objects).toHaveLength(1);

    // Idempotent: a second invocation finds the deletion done and calls nothing.
    expect(await runner({ runs: { run: runs }, composio: { run: composio } }).run(userId)).toEqual({
      status: "done",
    });
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it("bounds D1 batches per invocation and resumes where it stopped", async () => {
    const { userId } = await deletedAccount(5);
    const bounded = runner({ batchLimit: 2, maxBatches: 2 });
    const first = await bounded.run(userId);
    expect(first).toEqual({ status: "incomplete", stepsDone: ["runs", "composio", "r2"] });
    expect(
      await db.first(
        sql(`SELECT COUNT(*) AS n FROM probe_rows WHERE owner_id = :id`, { id: userId }),
      ),
    ).toEqual({ n: 1 });

    let result = await bounded.run(userId);
    for (let attempt = 0; result.status === "incomplete" && attempt < 10; attempt += 1) {
      result = await bounded.run(userId);
    }
    expect(result).toEqual({ status: "done" });
  });

  it("stops at an incomplete external step without recording it", async () => {
    const { userId } = await deletedAccount();
    let ready = false;
    const composio: AccountPurgeExternalStep = { run: async () => (ready ? "done" : "incomplete") };
    expect(await runner({ composio }).run(userId)).toEqual({
      status: "incomplete",
      stepsDone: ["runs"],
    });
    expect(
      await db.first(sql(`SELECT id FROM users WHERE id = :id`, { id: userId })),
    ).not.toBeNull();
    ready = true;
    expect(await runner({ composio }).run(userId)).toEqual({ status: "done" });
  });

  it("bounds object deletions per invocation", async () => {
    const { userId } = await deletedAccount();
    expect(await runner({ maxObjectDeletes: 2 }).run(userId)).toEqual({
      status: "incomplete",
      stepsDone: ["runs", "composio"],
    });
    expect((await store.list({ prefix: accountObjectPrefix(userId) })).objects).toHaveLength(1);
    expect(await runner({ maxObjectDeletes: 2 }).run(userId)).toEqual({ status: "done" });
  });

  it("rejects a contributor with statements but no remaining check, and unknown deletions", async () => {
    const { userId } = await deletedAccount();
    const broken: PurgeContributor = {
      domain: "search",
      statements: () => [sql(`DELETE FROM search_intents WHERE owner_id = :u`, { u: userId })],
    };
    await expect(runner({ contributors: [broken] }).run(userId)).rejects.toThrow(
      PurgeContributorError,
    );
    expect(await runner().run(uuidv7(now))).toEqual({ status: "not_found" });
  });
});
