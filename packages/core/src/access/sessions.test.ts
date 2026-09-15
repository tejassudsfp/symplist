import { randomBytes } from "node:crypto";
import { createKeyProvider, keyFamilies, type ManagedKeyProvider } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  type DbClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRevokeContributor } from "./session-revoke-contributors/types.ts";
import {
  csrfTokenForSession,
  isWellFormedSessionToken,
  SESSION_LIFETIME_MS,
  SESSION_TOUCH_INTERVAL_MS,
  SessionStore,
  verifyCsrfToken,
} from "./sessions.ts";

const now = 1_789_500_000_000;

function keyProvider(versions: ReadonlyMap<number, Uint8Array> = new Map([[1, randomBytes(32)]])) {
  const sources = Object.fromEntries(
    keyFamilies.map((family) => [
      family,
      { current: Math.max(...versions.keys()), versions: new Map(versions) },
    ]),
  );
  return createKeyProvider(sources);
}

let db: LocalSqliteClient;
let keys: ManagedKeyProvider;

async function createUser(
  client: DbClient,
  options: { deletion?: "none" | "deleting" } = {},
): Promise<string> {
  const id = uuidv7(now);
  await client.run(
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, deletion_state, deletion_requested_at,
         created_at, updated_at, write_id)
       VALUES (:id, :email, :now, 'unlocked', :deletion, :requested, :now, :now, :w)`,
      {
        id,
        email: `${id}@example.test`,
        now: int(now),
        deletion: options.deletion ?? "none",
        requested: options.deletion === "deleting" ? int(now) : null,
        w: uuidv7(now),
      },
    ),
  );
  return id;
}

beforeEach(async () => {
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  keys = keyProvider();
});

afterEach(() => {
  db.close();
  keys.destroy();
});

describe("SessionStore (§5.1)", () => {
  it("creates a session whose token is stored only as a versioned digest", async () => {
    const store = new SessionStore({ db, keys });
    const userId = await createUser(db);
    const created = await store.create({ userId, now });
    expect(created).not.toBeNull();
    if (!created) return;
    expect(isWellFormedSessionToken(created.token)).toBe(true);
    expect(created.expiresAt).toBe(now + SESSION_LIFETIME_MS);

    const rows = await db.all(sql(`SELECT * FROM auth_sessions`));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(created.token);
    expect(rows[0]).toMatchObject({ user_id: userId, digest_version: 1, revoked_at: null });
  });

  it("resolves a live token with the user's access fields in one read", async () => {
    const store = new SessionStore({ db, keys });
    const userId = await createUser(db);
    const created = await store.create({ userId, now });
    const batch = vi.spyOn(db, "batch");
    const resolved = await store.resolve(created?.token, now + 1000);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(resolved?.session).toMatchObject({ id: created?.sessionId, userId });
    expect(resolved?.access).toMatchObject({ betaState: "unlocked", deletionState: "none" });
  });

  it("never queries D1 for malformed tokens and rejects unknown, expired and revoked ones", async () => {
    const store = new SessionStore({ db, keys });
    const userId = await createUser(db);
    const created = await store.create({ userId, now });
    const batch = vi.spyOn(db, "batch");
    for (const malformed of [undefined, "", "short", `${"a".repeat(43)}=`, 42, "a".repeat(44)]) {
      expect(await store.resolve(malformed, now)).toBeNull();
    }
    expect(batch).not.toHaveBeenCalled();

    expect(await store.resolve(randomBytes(32).toString("base64url"), now)).toBeNull();
    expect(await store.resolve(created?.token, now + SESSION_LIFETIME_MS)).toBeNull();

    if (!created) return;
    expect(await store.revoke({ sessionId: created.sessionId, userId, now })).toBe(true);
    expect(await store.revoke({ sessionId: created.sessionId, userId, now })).toBe(false);
    expect(await store.resolve(created.token, now)).toBeNull();
  });

  it("refuses to create a session for a missing user or an account being deleted", async () => {
    const store = new SessionStore({ db, keys });
    expect(await store.create({ userId: uuidv7(now), now })).toBeNull();
    const deleting = await createUser(db, { deletion: "deleting" });
    expect(await store.create({ userId: deleting, now })).toBeNull();
  });

  it("does not revoke another user's session", async () => {
    const store = new SessionStore({ db, keys });
    const owner = await createUser(db);
    const other = await createUser(db);
    const created = await store.create({ userId: owner, now });
    if (!created) throw new Error("expected a session");
    expect(await store.revoke({ sessionId: created.sessionId, userId: other, now })).toBe(false);
    expect(await store.resolve(created.token, now)).not.toBeNull();
  });

  it("writes last-seen at most once per interval", async () => {
    const store = new SessionStore({ db, keys });
    const userId = await createUser(db);
    const created = await store.create({ userId, now });
    const resolved = await store.resolve(created?.token, now + 1000);
    if (!resolved) throw new Error("expected a session");
    expect(store.isTouchDue(resolved.session, now + SESSION_TOUCH_INTERVAL_MS - 1)).toBe(false);
    expect(store.isTouchDue(resolved.session, now + SESSION_TOUCH_INTERVAL_MS)).toBe(true);

    await store.touch(resolved.session.id, now + 60_000);
    let row = await db.first(sql(`SELECT last_seen_at FROM auth_sessions`));
    expect(row?.last_seen_at).toBe(now);

    await store.touch(resolved.session.id, now + SESSION_TOUCH_INTERVAL_MS);
    row = await db.first(sql(`SELECT last_seen_at FROM auth_sessions`));
    expect(row?.last_seen_at).toBe(now + SESSION_TOUCH_INTERVAL_MS);
  });

  it("revokes every session of a user together with contributed session-bound state", async () => {
    await db.executeScript(
      `CREATE TABLE probe_vault_sessions (user_id TEXT, revoked INTEGER) STRICT;`,
    );
    const contributor: SessionRevokeContributor = {
      domain: "vault",
      statements: ({ userId }) => [
        sql(`INSERT INTO probe_vault_sessions (user_id, revoked) VALUES (:user, 1)`, {
          user: userId,
        }),
      ],
    };
    const store = new SessionStore({ db, keys, revokeContributors: [contributor] });
    const userId = await createUser(db);
    const other = await createUser(db);
    const first = await store.create({ userId, now });
    const second = await store.create({ userId, now });
    const bystander = await store.create({ userId: other, now });

    const revoked = await store.revokeAll({ userId, now: now + 5 });
    expect([...revoked].sort()).toEqual([first?.sessionId, second?.sessionId].sort());
    expect(await store.resolve(first?.token, now + 10)).toBeNull();
    expect(await store.resolve(second?.token, now + 10)).toBeNull();
    expect(await store.resolve(bystander?.token, now + 10)).not.toBeNull();
    expect(await db.all(sql(`SELECT user_id FROM probe_vault_sessions`))).toEqual([
      { user_id: userId },
    ]);
  });

  it("rejects revoke contributors that write users or auth_sessions", async () => {
    const bad: SessionRevokeContributor = {
      domain: "vault",
      statements: () => [sql(`UPDATE auth_sessions SET revoked_at = 1`)],
    };
    const store = new SessionStore({ db, keys, revokeContributors: [bad] });
    const userId = await createUser(db);
    await expect(store.revokeAll({ userId, now })).rejects.toThrow(
      /must write only its own tables/,
    );
  });

  it("keeps sessions created under a rotated-out secret version valid while it stays configured", async () => {
    const v1 = randomBytes(32);
    const oldKeys = keyProvider(new Map([[1, v1]]));
    const userId = await createUser(db);
    const created = await new SessionStore({ db, keys: oldKeys }).create({ userId, now });

    const rotated = keyProvider(
      new Map([
        [1, v1],
        [2, randomBytes(32)],
      ]),
    );
    expect(
      await new SessionStore({ db, keys: rotated }).resolve(created?.token, now),
    ).not.toBeNull();

    const retired = keyProvider(new Map([[2, randomBytes(32)]]));
    expect(await new SessionStore({ db, keys: retired }).resolve(created?.token, now)).toBeNull();
    for (const provider of [oldKeys, rotated, retired]) provider.destroy();
  });
});

describe("session-bound CSRF tokens (§5.3)", () => {
  it("binds the token to one session and verifies it under every configured version", () => {
    const sessionA = uuidv7(now);
    const sessionB = uuidv7(now + 1);
    const token = csrfTokenForSession(keys, sessionA);
    expect(verifyCsrfToken(keys, sessionA, token)).toBe(true);
    expect(verifyCsrfToken(keys, sessionB, token)).toBe(false);
    expect(verifyCsrfToken(keys, sessionA, `${token.slice(0, -1)}A`)).toBe(token.endsWith("A"));
    expect(verifyCsrfToken(keys, sessionA, "1")).toBe(false);
    expect(verifyCsrfToken(keys, sessionA, undefined)).toBe(false);
    expect(verifyCsrfToken(keys, sessionA, [token])).toBe(false);
  });

  it("accepts a token issued before a rotation and rejects it once its version is retired", () => {
    const v1 = randomBytes(32);
    const before = keyProvider(new Map([[1, v1]]));
    const sessionId = uuidv7(now);
    const token = csrfTokenForSession(before, sessionId);
    const rotated = keyProvider(
      new Map([
        [1, v1],
        [2, randomBytes(32)],
      ]),
    );
    expect(verifyCsrfToken(rotated, sessionId, token)).toBe(true);
    expect(csrfTokenForSession(rotated, sessionId)).not.toBe(token);
    const retired = keyProvider(new Map([[2, randomBytes(32)]]));
    expect(verifyCsrfToken(retired, sessionId, token)).toBe(false);
    for (const provider of [before, rotated, retired]) provider.destroy();
  });
});
