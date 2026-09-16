import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Statement } from "./client.ts";
import { DbStatementError } from "./errors.ts";
import { createLocalSqliteClient, type LocalSqliteClient } from "./local-sqlite-client.ts";
import { applyMigrations } from "./migrations.ts";
import { int, json, sql } from "./query.ts";
import { newWriteId, verifiedRow, writeGuard } from "./write-id.ts";

const foundationTables = [
  "abuse_counters",
  "account_delete_authorizations",
  "account_deletions",
  "account_keys",
  "account_tombstones",
  "auth_sessions",
  "beta_admin_events",
  "dispatch_intents",
  "executor_state",
  "idempotency_records",
  "otp_challenges",
  "otp_limits",
  "search_intents",
  "tasks",
  "user_preferences",
  "users",
  "webhook_receipts",
];

const now = 1_789_500_000_000;
let dir: string;
let db: LocalSqliteClient;
let counter = 0;
const id = (prefix: string) => {
  counter += 1;
  return `${prefix}-${counter}`;
};

async function failure(statements: Statement | Statement[]): Promise<DbStatementError> {
  try {
    await db.batch(Array.isArray(statements) ? statements : [statements]);
  } catch (error) {
    if (error instanceof DbStatementError) return error;
    throw error;
  }
  throw new Error("expected the statement to fail");
}

function insertUser(overrides: Record<string, string | null> = {}): {
  id: string;
  statement: Statement;
} {
  const userId = overrides.id ?? id("user");
  const values: Record<string, string | null> = {
    id: userId,
    email: `${userId}@example.test`,
    created_at: int(now),
    updated_at: int(now),
    write_id: newWriteId(),
    ...overrides,
  };
  const columns = Object.keys(values);
  return {
    id: userId,
    statement: sql(
      `INSERT INTO users (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`,
      values,
    ),
  };
}

async function createUser(overrides: Record<string, string | null> = {}): Promise<string> {
  const user = insertUser(overrides);
  await db.run(user.statement);
  return user.id;
}

function insertTask(
  owner: string,
  overrides: Record<string, string | null> = {},
): { id: string; statement: Statement } {
  const taskId = overrides.id ?? id("task");
  const values: Record<string, string | null> = {
    id: taskId,
    owner_id: owner,
    parent_id: null,
    collection: "now",
    position: "a0",
    source: "user",
    write_id: newWriteId(),
    title_enc: "sym1.1.iv.ct",
    created_at: int(now),
    updated_at: int(now),
    ...overrides,
  };
  const columns = Object.keys(values);
  return {
    id: taskId,
    statement: sql(
      `INSERT INTO tasks (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`,
      values,
    ),
  };
}

async function createSession(userId: string): Promise<string> {
  const sessionId = id("session");
  await db.run(
    sql(
      `INSERT INTO auth_sessions (id, user_id, token_digest, digest_version, created_at, last_seen_at, expires_at, write_id)
       VALUES (:id, :user, :digest, '1', :now, :now, :expires, :w)`,
      {
        id: sessionId,
        user: userId,
        digest: id("digest"),
        now: int(now),
        expires: int(now + 1000),
        w: newWriteId(),
      },
    ),
  );
  return sessionId;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "symplist-schema-"));
  db = createLocalSqliteClient({ path: join(dir, "d1.sqlite"), env: {} });
  await applyMigrations(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("foundation schema (§3.4)", () => {
  it("creates every foundation table, and every table any migration adds, as STRICT", async () => {
    const tables = await db.all<{ name: string; strict: number }>(
      sql(
        `SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name`,
      ),
    );
    const names = tables.map((table) => table.name);
    // Feature ranges add their own tables (§3.4), so the foundation set is a subset, not the whole
    // list; every foundation table must still be there, exactly once and in order, and every table
    // in the database, whoever added it, must be STRICT.
    expect(names).toEqual(expect.arrayContaining(foundationTables));
    expect(names.filter((name) => foundationTables.includes(name))).toEqual(foundationTables);
    expect(tables.filter((table) => table.strict !== 1)).toEqual([]);
  });

  it("gives every mutable foundation table a write_id column", async () => {
    const immutable = new Set([
      "account_tombstones",
      "beta_admin_events",
      "search_intents",
      "webhook_receipts",
    ]);
    for (const table of foundationTables.filter((name) => !immutable.has(name))) {
      const columns = await db.all<{ name: string; notnull: number }>(
        sql(`SELECT name, "notnull" FROM pragma_table_info('${table}')`),
      );
      expect(columns, table).toContainEqual({ name: "write_id", notnull: 1 });
    }
  });

  it("takes the account_delete_authorizations columns from §3.4", async () => {
    const columns = await db.all<{ name: string }>(
      sql(`SELECT name FROM pragma_table_info('account_delete_authorizations') ORDER BY cid`),
    );
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "id",
        "user_id",
        "auth_session_id",
        "challenge_id",
        "expires_at",
        "consumed_at",
        "write_id",
      ]),
    );
  });

  it("seeds exactly one executor_state row", async () => {
    await expect(db.all(sql("SELECT id, mode, generation FROM executor_state"))).resolves.toEqual([
      { id: 1, mode: null, generation: 1 },
    ]);
    expect(
      (
        await failure(
          sql(
            "INSERT INTO executor_state (id, generation, updated_at, write_id) VALUES (2, 1, 0, 'w')",
          ),
        )
      ).constraint,
    ).toBe("check");
    expect((await failure(sql("UPDATE executor_state SET mode = 'hybrid'"))).constraint).toBe(
      "check",
    );
    expect((await failure(sql("UPDATE executor_state SET generation = 0"))).constraint).toBe(
      "check",
    );
  });
});

describe("users", () => {
  it("defaults the access, deletion and consent fields", async () => {
    const userId = await createUser();
    await expect(
      db.first(
        sql(
          "SELECT beta_state, onboarding_step, role, access_generation, access_epoch, deletion_state, analytics_consent, analytics_id FROM users WHERE id = :id",
          { id: userId },
        ),
      ),
    ).resolves.toEqual({
      beta_state: "locked",
      onboarding_step: "name",
      role: "member",
      access_generation: 0,
      access_epoch: 0,
      deletion_state: "none",
      analytics_consent: "unset",
      analytics_id: null,
    });
  });

  it("enforces unique emails and analytics ids", async () => {
    const email = `${id("dup")}@example.test`;
    await createUser({ email });
    expect((await failure(insertUser({ email }).statement)).constraint).toBe("unique");
    const analyticsId = id("analytics");
    await createUser({
      analytics_id: analyticsId,
      analytics_consent: "granted",
      analytics_consent_at: int(now),
    });
    expect((await failure(insertUser({ analytics_id: analyticsId }).statement)).constraint).toBe(
      "unique",
    );
  });

  it("checks every enum and state invariant", async () => {
    const cases: Array<Record<string, string | null>> = [
      { beta_state: "open" },
      { onboarding_step: "profile" },
      { role: "owner" },
      { deletion_state: "deleted" },
      { deletion_state: "deleting" },
      { analytics_consent: "maybe" },
      { analytics_consent: "granted" },
      { access_generation: int(-1) },
      { access_epoch: int(-1) },
      { email: "no-at-sign" },
    ];
    for (const overrides of cases) {
      expect(
        (await failure(insertUser(overrides).statement)).constraint,
        JSON.stringify(overrides),
      ).toBe("check");
    }
    expect((await failure(insertUser({ access_generation: "many" }).statement)).kind).toBe("type");
  });
});

describe("auth, OTP and deletion authorizations", () => {
  it("enforces unique session token digests and session invariants", async () => {
    const userId = await createUser();
    await createSession(userId);
    const digest = id("digest");
    const insert = (sessionId: string, expires: number) =>
      sql(
        `INSERT INTO auth_sessions (id, user_id, token_digest, digest_version, created_at, last_seen_at, expires_at, write_id)
         VALUES (:id, :user, :digest, '1', :now, :now, :expires, 'w')`,
        { id: sessionId, user: userId, digest, now: int(now), expires: int(expires) },
      );
    await db.run(insert(id("session"), now + 1));
    expect((await failure(insert(id("session"), now + 1))).constraint).toBe("unique");
    expect(
      (
        await failure(
          sql(
            `INSERT INTO auth_sessions (id, user_id, token_digest, digest_version, created_at, last_seen_at, expires_at, write_id) VALUES ('s-bad', :user, 'd-bad', '1', :now, :now, :now, 'w')`,
            { user: userId, now: int(now) },
          ),
        )
      ).constraint,
    ).toBe("check");
    expect(
      (
        await failure(
          sql(
            `INSERT INTO auth_sessions (id, user_id, token_digest, digest_version, created_at, last_seen_at, expires_at, write_id) VALUES ('s-orphan', 'no-user', 'd-orphan', '1', :now, :now, :later, 'w')`,
            { now: int(now), later: int(now + 1) },
          ),
        )
      ).constraint,
    ).toBe("foreign_key");
  });

  it("allows one live OTP challenge per user and purpose, superseded in the same batch", async () => {
    const userId = await createUser();
    const challenge = (challengeId: string, purpose = "login", session: string | null = null) =>
      sql(
        `INSERT INTO otp_challenges (id, user_id, purpose, auth_session_id, code_digest, digest_version, created_at, expires_at, write_id)
         VALUES (:id, :user, :purpose, :session, 'digest', '1', :now, :expires, 'w')`,
        {
          id: challengeId,
          user: userId,
          purpose,
          session,
          now: int(now),
          expires: int(now + 600_000),
        },
      );
    await db.run(challenge("otp-1"));
    expect((await failure(challenge("otp-2"))).constraint).toBe("unique");
    await db.batch([
      sql(
        "UPDATE otp_challenges SET superseded_at = :now WHERE user_id = :user AND purpose = 'login' AND consumed_at IS NULL AND superseded_at IS NULL",
        { now: int(now), user: userId },
      ),
      challenge("otp-2"),
    ]);
    await db.run(challenge("otp-3", "signup"));
    expect((await failure(challenge("otp-4", "password_reset"))).constraint).toBe("check");
    expect((await failure(challenge("otp-5", "account_delete"))).constraint).toBe("check");
    expect(
      (
        await failure(
          sql("UPDATE otp_challenges SET consumed_at = :now WHERE id = 'otp-1'", { now: int(now) }),
        )
      ).constraint,
    ).toBe("check");
  });

  it("binds account deletion authorizations to one challenge, user and session", async () => {
    const userId = await createUser();
    const sessionId = await createSession(userId);
    await db.run(
      sql(
        `INSERT INTO otp_challenges (id, user_id, purpose, auth_session_id, code_digest, digest_version, created_at, expires_at, consumed_at, write_id)
         VALUES ('otp-delete', :user, 'account_delete', :session, 'digest', '1', :now, :expires, :now, 'w')`,
        { user: userId, session: sessionId, now: int(now), expires: int(now + 600_000) },
      ),
    );
    const authorization = (authId: string, session = sessionId, challenge = "otp-delete") =>
      sql(
        `INSERT INTO account_delete_authorizations (id, user_id, auth_session_id, challenge_id, created_at, expires_at, write_id)
         VALUES (:id, :user, :session, :challenge, :now, :expires, 'w')`,
        {
          id: authId,
          user: userId,
          session,
          challenge,
          now: int(now),
          expires: int(now + 600_000),
        },
      );
    await db.run(authorization("auth-1"));
    expect((await failure(authorization("auth-2"))).constraint).toBe("unique");
    expect(
      (await failure(authorization("auth-3", "missing-session", "missing-challenge"))).constraint,
    ).toBe("foreign_key");
  });

  it("keys OTP limits by email digest and purpose", async () => {
    const limit = (purpose: string) =>
      sql(
        `INSERT INTO otp_limits (email_digest, digest_version, purpose, hour_window_start, hour_challenges, day_window_start, day_challenges, updated_at, write_id)
         VALUES ('email-digest', '1', :purpose, :now, '1', :now, '1', :now, 'w')`,
        { purpose, now: int(now) },
      );
    await db.run(limit("login"));
    await db.run(limit("signup"));
    expect(["primary_key", "unique"]).toContain((await failure(limit("login"))).constraint);
    expect((await failure(limit("reset"))).constraint).toBe("check");
    expect(
      (await failure(sql("UPDATE otp_limits SET failures = 3 WHERE purpose = 'login'"))).constraint,
    ).toBe("check");
    expect(
      (await failure(sql("UPDATE otp_limits SET hour_challenges = -1 WHERE purpose = 'login'")))
        .constraint,
    ).toBe("check");
  });
});

describe("idempotency, dispatch and webhooks", () => {
  it("keys idempotency records by scope, user and key", async () => {
    const userId = await createUser();
    const record = (status: string, httpStatus: string | null) =>
      sql(
        `INSERT INTO idempotency_records (scope, user_id, key, fingerprint, fingerprint_version, status, http_status, response_enc, created_at, updated_at, expires_at, write_id)
         VALUES ('tasks.complete', :user, 'key-1', 'fp', '1', :status, :http, NULL, :now, :now, :expires, 'w')`,
        { user: userId, status, http: httpStatus, now: int(now), expires: int(now + 86_400_000) },
      );
    await db.run(record("completed", "200"));
    expect(["primary_key", "unique"]).toContain(
      (await failure(record("completed", "200"))).constraint,
    );
    await db.run(sql("DELETE FROM idempotency_records WHERE user_id = :user", { user: userId }));
    expect((await failure(record("completed", null))).constraint).toBe("check");
    expect((await failure(record("done", "200"))).constraint).toBe("check");
  });

  it("allows one dispatch intent per kind and subject and checks lifecycle invariants", async () => {
    const intent = (intentId: string, overrides: Record<string, string | null> = {}) => {
      const values: Record<string, string | null> = {
        id: intentId,
        owner_id: "owner-1",
        kind: "simon_run",
        subject_id: "run-1",
        executor_generation: "1",
        created_at: int(now),
        updated_at: int(now),
        write_id: "w",
        ...overrides,
      };
      const columns = Object.keys(values);
      return sql(
        `INSERT INTO dispatch_intents (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`,
        values,
      );
    };
    await db.run(intent("intent-1"));
    expect((await failure(intent("intent-2"))).constraint).toBe("unique");
    await db.run(intent("intent-3", { kind: "account_purge", subject_id: "user-x" }));
    expect(
      (await failure(intent("intent-4", { kind: "Simon-Run", subject_id: "run-9" }))).constraint,
    ).toBe("check");
    expect(
      (await failure(intent("intent-5", { subject_id: "run-5", status: "dispatched" }))).constraint,
    ).toBe("check");
    expect(
      (
        await failure(
          intent("intent-6", { subject_id: "run-6", trigger_run_id: "run_abc", executor: "local" }),
        )
      ).constraint,
    ).toBe("check");
    await db.run(
      intent("intent-7", {
        subject_id: "run-7",
        status: "dispatched",
        executor: "trigger",
        dispatched_at: int(now),
        trigger_run_id: "run_abc",
      }),
    );
  });

  it("deduplicates webhook receipts per provider", async () => {
    const receipt = (provider: string, receiptId: string) =>
      sql(
        "INSERT INTO webhook_receipts (provider, receipt_id, received_at) VALUES (:provider, :receipt, :now)",
        {
          provider,
          receipt: receiptId,
          now: int(now),
        },
      );
    await db.run(receipt("resend", "msg_1"));
    await db.run(receipt("composio", "msg_1"));
    expect(["primary_key", "unique"]).toContain(
      (await failure(receipt("resend", "msg_1"))).constraint,
    );
    expect((await failure(receipt("stripe", "msg_2"))).constraint).toBe("check");
  });
});

describe("beta_admin_events (append-only)", () => {
  const event = (
    eventId: string,
    action: string,
    overrides: Record<string, string | null> = {},
  ) => {
    const values: Record<string, string | null> = {
      id: eventId,
      actor_kind: "admin",
      actor_id: "admin-1",
      action,
      target_kind: "user",
      target_id: "user-1",
      created_at: int(now),
      ...overrides,
    };
    const columns = Object.keys(values);
    return sql(
      `INSERT INTO beta_admin_events (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`,
      values,
    );
  };

  it("rejects UPDATE and DELETE through its triggers even without the client guard", async () => {
    await db.run(
      event("event-1", "account_unlocked", { after_json: json({ beta_state: "unlocked" }) }),
    );
    const raw = new DatabaseSync(join(dir, "d1.sqlite"), { timeout: 5_000 });
    try {
      expect(() =>
        raw.exec("UPDATE beta_admin_events SET action = 'tampered' WHERE id = 'event-1'"),
      ).toThrow(/append_only: beta_admin_events/);
      expect(() => raw.exec("DELETE FROM beta_admin_events WHERE id = 'event-1'")).toThrow(
        /append_only: beta_admin_events/,
      );
      expect(() =>
        raw.exec(
          "INSERT INTO beta_admin_events (id, actor_kind, action, target_kind, created_at) VALUES ('event-1', 'system', 'x', 'system', 0) ON CONFLICT (id) DO UPDATE SET action = 'tampered'",
        ),
      ).toThrow(/append_only/);
    } finally {
      raw.close();
    }
    await expect(
      db.first(sql("SELECT action FROM beta_admin_events WHERE id = 'event-1'")),
    ).resolves.toEqual({ action: "account_unlocked" });
  });

  it("rejects UPDATE, DELETE and REPLACE through the DbClient before execution", async () => {
    await expect(db.run(sql("UPDATE beta_admin_events SET action = 'x'"))).rejects.toMatchObject({
      code: "db.append_only",
    });
    await expect(db.run(sql("DELETE FROM beta_admin_events"))).rejects.toMatchObject({
      code: "db.append_only",
    });
    await expect(
      db.run(
        sql(
          "INSERT OR REPLACE INTO beta_admin_events (id, actor_kind, action, target_kind, created_at) VALUES ('event-1', 'system', 'x', 'system', 0)",
        ),
      ),
    ).rejects.toMatchObject({ code: "db.append_only" });
  });

  it("allows one admin_bootstrap event and checks actor and reason pairing", async () => {
    await db.run(event("bootstrap-1", "admin_bootstrap", { actor_kind: "system", actor_id: null }));
    expect(
      (
        await failure(
          event("bootstrap-2", "admin_bootstrap", { actor_kind: "system", actor_id: null }),
        )
      ).constraint,
    ).toBe("unique");
    await db.run(event("rebootstrap-1", "admin_rebootstrap"));
    expect(
      (await failure(event("event-2", "account_relocked", { actor_id: null }))).constraint,
    ).toBe("check");
    expect(
      (await failure(event("event-3", "account_relocked", { reason_enc: "sym1.1.iv.ct" })))
        .constraint,
    ).toBe("check");
    expect((await failure(event("event-4", "Account Relocked"))).constraint).toBe("check");
    expect(
      (await failure(event("event-5", "account_relocked", { before_json: "{not json" })))
        .constraint,
    ).toBe("check");
    await db.run(event("event-6", "invite_redeemed", { actor_kind: "user", request_id: "req-1" }));
    expect(
      (
        await failure(
          event("event-7", "invite_redeemed", { actor_kind: "user", request_id: "req-1" }),
        )
      ).constraint,
    ).toBe("unique");
  });

  it("lets the §5.7 bootstrap statement read the table inside an UPDATE of users", async () => {
    const userId = await createUser({ email_verified_at: int(now) });
    const guard = writeGuard({ table: "users", id: userId });
    const results = await db.batch([
      sql(
        `UPDATE users SET role = 'admin', write_id = :w WHERE id = :user AND email_verified_at IS NOT NULL AND suspended_at IS NULL
         AND beta_state <> 'relocked' AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
         AND NOT EXISTS (SELECT 1 FROM beta_admin_events WHERE action = 'admin_bootstrap')`,
        { w: guard.writeId, user: userId },
      ),
      guard.verify(),
    ]);
    // A bootstrap event already exists, so the conditional statement decides "no".
    expect(verifiedRow(results)).toBeNull();
  });
});

describe("tasks", () => {
  let owner: string;
  let other: string;
  beforeEach(async () => {
    owner = await createUser();
    other = await createUser();
  });

  it("checks collection, status, source and archive invariants", async () => {
    const cases: Array<Record<string, string | null>> = [
      { collection: "someday" },
      { status: "deleted" },
      { status: "archived" },
      { archived_at: int(now) },
      { archived_with_root_id: "root" },
      { source: "mcp:" },
      { source: "robot" },
      { version: "0" },
      { position: "" },
    ];
    for (const overrides of cases) {
      expect(
        (await failure(insertTask(owner, overrides).statement)).constraint,
        JSON.stringify(overrides),
      ).toBe("check");
    }
    await db.run(insertTask(owner, { source: "mcp:grant-1" }).statement);
    await db.run(
      insertTask(owner, {
        status: "archived",
        archived_at: int(now),
        archived_with_root_id: "root",
      }).statement,
    );
  });

  it("keeps parents inside the owner's tree and never self-parented", async () => {
    const parent = insertTask(owner);
    await db.run(parent.statement);
    await db.run(insertTask(owner, { parent_id: parent.id }).statement);
    expect((await failure(insertTask(other, { parent_id: parent.id }).statement)).constraint).toBe(
      "foreign_key",
    );
    expect((await failure(insertTask(owner, { parent_id: "missing" }).statement)).constraint).toBe(
      "foreign_key",
    );
    const selfId = id("task");
    expect(
      (await failure(insertTask(owner, { id: selfId, parent_id: selfId }).statement)).constraint,
    ).toBe("check");
  });

  it("supports the active-task guard as the deciding conditional statement (§2.1)", async () => {
    const task = insertTask(owner);
    await db.run(task.statement);
    const rename = async (taskId: string, ownerId: string, title: string) => {
      const guard = writeGuard({ table: "tasks", id: taskId });
      const results = await db.batch([
        sql(
          `UPDATE tasks SET title_enc = :title, version = version + 1, write_id = :w, updated_at = :now
           WHERE id = :task AND owner_id = :owner
             AND EXISTS (SELECT 1 FROM tasks WHERE id = :task AND owner_id = :owner AND status = 'active')`,
          { title, w: guard.writeId, now: int(now + 1), task: taskId, owner: ownerId },
        ),
        sql(
          `INSERT INTO search_intents (owner_id, entity, entity_id, revision_or_seq, op, created_at)
           SELECT :owner, 'task', id, version, 'upsert', :now FROM tasks WHERE id = :task AND ${guard.exists}`,
          { owner: ownerId, task: taskId, now: int(now + 1), ...guard.params },
        ),
        guard.verify(["id", "version"]),
      ]);
      return verifiedRow<{ id: string; version: number }>(results);
    };
    const intents = () =>
      db.all(
        sql(
          "SELECT entity_id, revision_or_seq FROM search_intents WHERE entity_id = :task ORDER BY id",
          { task: task.id },
        ),
      );

    await expect(rename(task.id, owner, "sym1.1.iv.renamed")).resolves.toEqual({
      id: task.id,
      version: 2,
    });
    await expect(intents()).resolves.toEqual([{ entity_id: task.id, revision_or_seq: 2 }]);

    // Another owner's attempt decides "not found" and its guarded intent never lands.
    await expect(rename(task.id, other, "sym1.1.iv.foreign")).resolves.toBeNull();

    await db.run(
      sql(
        "UPDATE tasks SET status = 'archived', archived_at = :now, archived_with_root_id = :task WHERE id = :task",
        {
          now: int(now + 2),
          task: task.id,
        },
      ),
    );
    // An archived task fails the guard: the service returns task.archived (409).
    await expect(rename(task.id, owner, "sym1.1.iv.late")).resolves.toBeNull();
    await expect(intents()).resolves.toEqual([{ entity_id: task.id, revision_or_seq: 2 }]);
  });
});

describe("preferences, search intents and account deletion records", () => {
  it("versions preferences per owner and group", async () => {
    const owner = await createUser();
    const preference = (group: string) =>
      sql(
        `INSERT INTO user_preferences (owner_id, "group", version, data_enc, updated_at, write_id) VALUES (:owner, :group, '1', 'sym1.1.iv.ct', :now, 'w')`,
        {
          owner,
          group,
          now: int(now),
        },
      );
    await db.run(preference("appearance"));
    await db.run(preference("keyboard"));
    expect(["primary_key", "unique"]).toContain(
      (await failure(preference("appearance"))).constraint,
    );
    expect((await failure(preference("billing"))).constraint).toBe("check");
    expect(
      (
        await failure(
          sql(`UPDATE user_preferences SET version = 0 WHERE owner_id = :owner`, { owner }),
        )
      ).constraint,
    ).toBe("check");
  });

  it("orders search intents by id and checks entity and op", async () => {
    const owner = await createUser();
    const intent = (entity: string, op: string) =>
      sql(
        "INSERT INTO search_intents (owner_id, entity, entity_id, revision_or_seq, op, created_at) VALUES (:owner, :entity, 'e', '1', :op, :now) RETURNING id",
        {
          owner,
          entity,
          op,
          now: int(now),
        },
      );
    const [first] = await db.batch([intent("document", "upsert")]);
    const [second] = await db.batch([intent("message", "delete")]);
    expect(Number(second?.results[0]?.id)).toBeGreaterThan(Number(first?.results[0]?.id));
    expect((await failure(intent("vault", "upsert"))).constraint).toBe("check");
    expect((await failure(intent("task", "rename"))).constraint).toBe("check");
  });

  it("binds deletion records to the user's Composio id and R2 prefix", async () => {
    const deletion = (userId: string, overrides: Record<string, string | null> = {}) => {
      const values: Record<string, string | null> = {
        user_id: userId,
        analytics_id: null,
        email_digest: "digest",
        email_digest_version: "1",
        composio_user_id: userId,
        r2_prefix: `u/${userId}/`,
        requested_at: int(now),
        updated_at: int(now),
        write_id: "w",
        ...overrides,
      };
      const columns = Object.keys(values);
      return sql(
        `INSERT INTO account_deletions (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`,
        values,
      );
    };
    await db.run(deletion("deleted-1"));
    await expect(
      db.first(sql("SELECT status, steps_done FROM account_deletions WHERE user_id = 'deleted-1'")),
    ).resolves.toEqual({
      status: "pending",
      steps_done: "[]",
    });
    expect(
      (await failure(deletion("deleted-2", { composio_user_id: "someone-else" }))).constraint,
    ).toBe("check");
    expect((await failure(deletion("deleted-3", { r2_prefix: "u/" }))).constraint).toBe("check");
    expect(
      (await failure(deletion("deleted-4", { steps_done: json({ step: 1 }) }))).constraint,
    ).toBe("check");
    expect((await failure(deletion("deleted-5", { status: "done" }))).constraint).toBe("check");
    await db.run(
      deletion("deleted-6", {
        status: "done",
        completed_at: int(now),
        steps_done: json(["composio", "r2"]),
      }),
    );
    expect(["primary_key", "unique"]).toContain((await failure(deletion("deleted-1"))).constraint);

    await db.run(
      sql(
        "INSERT INTO account_tombstones (user_id, email_digest, digest_version, deleted_at) VALUES ('deleted-6', 'digest', '1', :now)",
        { now: int(now) },
      ),
    );
    expect(["primary_key", "unique"]).toContain(
      (
        await failure(
          sql(
            "INSERT INTO account_tombstones (user_id, email_digest, digest_version, deleted_at) VALUES ('deleted-6', 'digest', '1', :now)",
            { now: int(now) },
          ),
        )
      ).constraint,
    );
  });

  it("runs the §5.6 deletion decision as one guarded batch that shreds the account key", async () => {
    const userId = await createUser({
      analytics_id: id("analytics"),
      analytics_consent: "granted",
      analytics_consent_at: int(now),
    });
    const sessionId = await createSession(userId);
    await db.batch([
      sql(
        `INSERT INTO otp_challenges (id, user_id, purpose, auth_session_id, code_digest, digest_version, created_at, expires_at, consumed_at, write_id)
         VALUES (:challenge, :user, 'account_delete', :session, 'digest', '1', :now, :expires, :now, 'w')`,
        {
          challenge: `${userId}-otp`,
          user: userId,
          session: sessionId,
          now: int(now),
          expires: int(now + 600_000),
        },
      ),
      sql(
        `INSERT INTO account_delete_authorizations (id, user_id, auth_session_id, challenge_id, created_at, expires_at, write_id)
         VALUES (:auth, :user, :session, :challenge, :now, :expires, 'w')`,
        {
          auth: `${userId}-auth`,
          user: userId,
          session: sessionId,
          challenge: `${userId}-otp`,
          now: int(now),
          expires: int(now + 600_000),
        },
      ),
      sql(
        `INSERT INTO account_keys (owner_id, kek_version, wrapped_key, created_at, updated_at, write_id) VALUES (:user, '1', 'wrapped', :now, :now, 'w')`,
        {
          user: userId,
          now: int(now),
        },
      ),
    ]);

    const deleteAccount = async (authorization: string) => {
      const guard = writeGuard({ table: "users", id: userId });
      const params = { ...guard.params, now: int(now + 60_000), user: userId };
      return verifiedRow(
        await db.batch([
          sql(
            `UPDATE users SET deletion_state = 'deleting', deletion_requested_at = :now, access_generation = access_generation + 1, write_id = :w
             WHERE id = :user AND deletion_state = 'none' AND EXISTS (SELECT 1 FROM account_delete_authorizations
               WHERE id = :auth AND user_id = :user AND auth_session_id = :session AND consumed_at IS NULL AND expires_at > :now)`,
            {
              w: guard.writeId,
              user: userId,
              now: int(now + 60_000),
              auth: authorization,
              session: sessionId,
            },
          ),
          sql(
            `UPDATE account_delete_authorizations SET consumed_at = :now WHERE id = :auth AND consumed_at IS NULL AND ${guard.exists}`,
            {
              ...guard.params,
              now: int(now + 60_000),
              auth: authorization,
            },
          ),
          sql(
            `INSERT INTO account_deletions (user_id, analytics_id, email_digest, email_digest_version, composio_user_id, r2_prefix, requested_at, updated_at, write_id)
             SELECT id, analytics_id, 'tombstone-digest', '1', id, 'u/' || id || '/', :now, :now, :w FROM users WHERE id = :user AND ${guard.exists}`,
            { ...params, w: guard.writeId },
          ),
          sql(
            `UPDATE auth_sessions SET revoked_at = :now WHERE user_id = :user AND revoked_at IS NULL AND ${guard.exists}`,
            params,
          ),
          sql(`DELETE FROM account_keys WHERE owner_id = :user AND ${guard.exists}`, {
            ...guard.params,
            user: userId,
          }),
          guard.verify(["id", "access_generation"]),
        ]),
      );
    };

    await expect(deleteAccount("wrong-authorization")).resolves.toBeNull();
    await expect(
      db.first(sql("SELECT owner_id FROM account_keys WHERE owner_id = :user", { user: userId })),
    ).resolves.not.toBeNull();

    await expect(deleteAccount(`${userId}-auth`)).resolves.toEqual({
      id: userId,
      access_generation: 1,
    });
    await expect(
      db.first(sql("SELECT owner_id FROM account_keys WHERE owner_id = :user", { user: userId })),
    ).resolves.toBeNull();
    await expect(
      db.first(
        sql("SELECT composio_user_id, r2_prefix FROM account_deletions WHERE user_id = :user", {
          user: userId,
        }),
      ),
    ).resolves.toEqual({
      composio_user_id: userId,
      r2_prefix: `u/${userId}/`,
    });
    await expect(
      db.first(
        sql("SELECT revoked_at FROM auth_sessions WHERE id = :session", { session: sessionId }),
      ),
    ).resolves.toEqual({ revoked_at: now + 60_000 });

    // The authorization is single-use: a replay decides nothing and changes nothing.
    await expect(deleteAccount(`${userId}-auth`)).resolves.toBeNull();
    await expect(
      db.first(sql("SELECT access_generation FROM users WHERE id = :user", { user: userId })),
    ).resolves.toEqual({ access_generation: 1 });
  });
});
