import { randomBytes } from "node:crypto";
import { normalizeEmail } from "@symplist/contracts";
import {
  computeDigest,
  createKeyProvider,
  decryptFieldText,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1AccessService } from "../access/restrict.ts";
import type { RestrictContributor } from "../access/restrict-contributors/types.ts";
import { SessionStore } from "../access/sessions.ts";
import { restrictGuard } from "../access/sql.ts";
import {
  ACCOUNT_PURGE_INTENT_KIND,
  AccountDeletionService,
  accountObjectPrefix,
  buildAccountDeletionBatch,
} from "./deletion.ts";
import { AccountKeyStore } from "./keys.ts";

const now = 1_789_500_000_000;
let db: LocalSqliteClient;
let keys: ManagedKeyProvider;

const context = (ownerId: string) => ({
  purpose: "title",
  ownerId,
  table: "tasks",
  rowId: "row-1",
  column: "title_enc",
});

async function setup(contributors: readonly RestrictContributor[] = []) {
  const effects = {
    restriction: vi.fn(async () => undefined),
    deletion: vi.fn(async () => undefined),
  };
  const access = new D1AccessService({
    db,
    policy: { betaAccessRequired: true },
    contributors,
    effects: [{ name: "restriction", afterCommit: effects.restriction }],
  });
  const sessions = new SessionStore({ db, keys });
  const accountKeys = new AccountKeyStore({ db, keys });
  const service = new AccountDeletionService({
    db,
    keys,
    access,
    sessions,
    effects: [{ name: "posthog", afterCommit: effects.deletion }],
  });
  const userId = uuidv7(now);
  const email = `  Deleted.User@Example.test `;
  await db.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, analytics_id, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, 'relocked', :analytics, :now, :now, :w)`,
      {
        id: userId,
        email: normalizeEmail(email),
        now: int(now),
        analytics: "analytics-random-id",
        w: uuidv7(now),
      },
    ),
    accountKeys.provisionStatement({ userId, now }),
  ]);
  const session = await sessions.create({ userId, now });
  const otherSession = await sessions.create({ userId, now });
  if (!session || !otherSession) throw new Error("expected sessions");
  const challengeId = uuidv7(now);
  const authorizationId = uuidv7(now);
  await db.batch([
    sql(
      `INSERT INTO otp_challenges (id, user_id, purpose, auth_session_id, code_digest, digest_version,
         created_at, expires_at, consumed_at, write_id)
       VALUES (:id, :user, 'account_delete', :session, 'digest', 1, :now, :expires, :now, :w)`,
      {
        id: challengeId,
        user: userId,
        session: session.sessionId,
        now: int(now),
        expires: int(now + 600_000),
        w: uuidv7(now),
      },
    ),
    sql(
      `INSERT INTO account_delete_authorizations (id, user_id, auth_session_id, challenge_id, created_at,
         expires_at, consumed_at, write_id)
       VALUES (:id, :user, :session, :challenge, :now, :expires, NULL, :w)`,
      {
        id: authorizationId,
        user: userId,
        session: session.sessionId,
        challenge: challengeId,
        now: int(now),
        expires: int(now + 600_000),
        w: uuidv7(now),
      },
    ),
  ]);
  const key = await accountKeys.require(userId);
  const envelope = encryptFieldText(key, context(userId), "a private task title");
  // Before the shred the stored key still opens the envelope.
  expect(decryptFieldText(await accountKeys.require(userId), context(userId), envelope)).toBe(
    "a private task title",
  );
  return {
    service,
    accountKeys,
    sessions,
    effects,
    userId,
    email,
    session,
    otherSession,
    authorizationId,
    envelope,
    key,
  };
}

beforeEach(async () => {
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  const sources = Object.fromEntries(
    keyFamilies.map((family) => [
      family,
      { current: 1, versions: new Map([[1, randomBytes(32)]]) },
    ]),
  );
  keys = createKeyProvider(sources);
});

afterEach(() => {
  db.close();
  keys.destroy();
});

describe("account deletion batch (§5.6)", () => {
  it("orders the eight statements with the crypto-shred right before the verification", async () => {
    const { userId, authorizationId, session } = await setup();
    const access = new D1AccessService({
      db,
      policy: { betaAccessRequired: true },
      contributors: [],
    });
    const batch = buildAccountDeletionBatch(
      { keys, access, sessions: new SessionStore({ db, keys }) },
      { userId, authorizationId, authSessionId: session.sessionId, email: "x@example.test", now },
    );
    const texts = batch.statements.map((statement) => statement.sql.replace(/\s+/g, " ").trim());
    expect(texts[0]).toMatch(/^UPDATE users SET deletion_state = 'deleting'/);
    expect(texts[1]).toMatch(/^UPDATE account_delete_authorizations/);
    expect(texts[2]).toMatch(/^INSERT INTO account_deletions/);
    expect(texts.at(-3)).toMatch(/^INSERT INTO dispatch_intents/);
    expect(texts.at(-2)).toMatch(/^DELETE FROM account_keys/);
    expect(texts.at(-1)).toMatch(/^SELECT u\.id/);
    expect(batch.verifyIndex).toBe(batch.statements.length - 1);
    for (const text of texts.slice(1, -1)) {
      expect(text).toMatch(/FROM users WHERE id = \? AND write_id = \?/);
    }
  });

  it("deletes with a valid authorization: restriction, revocation, purge intent and crypto-shred", async () => {
    await db.executeScript(`CREATE TABLE probe_revocations (user_id TEXT NOT NULL) STRICT;`);
    const probe: RestrictContributor = {
      domain: "vault",
      statements: (input) => {
        const guard = restrictGuard(input);
        return [
          sql(
            `INSERT INTO probe_revocations (user_id) SELECT :restrict_user WHERE ${guard.exists}`,
            guard.params,
          ),
        ];
      },
    };
    const state = await setup([probe]);
    const batch = vi.spyOn(db, "batch");
    const result = await state.service.delete({
      userId: state.userId,
      authorizationId: state.authorizationId,
      authSessionId: state.session.sessionId,
      now: now + 1000,
    });
    expect(result).toEqual({ status: "deleted", analyticsId: "analytics-random-id" });
    // One fresh read of the account (§3.3), then the deletion itself as one batch.
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[1]?.[0].length).toBeGreaterThanOrEqual(8);

    const user = await db.first(
      sql(`SELECT deletion_state, access_generation FROM users WHERE id = :id`, {
        id: state.userId,
      }),
    );
    expect(user).toEqual({ deletion_state: "deleting", access_generation: 1 });
    expect(await db.first(sql(`SELECT consumed_at FROM account_delete_authorizations`))).toEqual({
      consumed_at: now + 1000,
    });
    const deletion = await db.first(
      sql(`SELECT * FROM account_deletions WHERE user_id = :id`, { id: state.userId }),
    );
    const digest = computeDigest(
      keys,
      "OTP_DIGEST_SECRET",
      "account-tombstone",
      "deleted.user@example.test",
    );
    expect(deletion).toMatchObject({
      analytics_id: "analytics-random-id",
      email_digest: digest.digest,
      email_digest_version: 1,
      composio_user_id: state.userId,
      r2_prefix: accountObjectPrefix(state.userId),
      status: "pending",
      steps_done: "[]",
    });
    expect(JSON.stringify(deletion)).not.toContain("deleted.user");
    expect(
      await db.first(
        sql(`SELECT kind, subject_id, status, executor_generation FROM dispatch_intents`),
      ),
    ).toEqual({
      kind: ACCOUNT_PURGE_INTENT_KIND,
      subject_id: state.userId,
      status: "pending",
      executor_generation: 1,
    });
    expect(await db.all(sql(`SELECT user_id FROM probe_revocations`))).toEqual([
      { user_id: state.userId },
    ]);
    expect(await state.sessions.resolve(state.session.token, now + 2000)).toBeNull();
    expect(await state.sessions.resolve(state.otherSession.token, now + 2000)).toBeNull();

    // The shred: the key row is gone, so no process can unwrap the key that sealed the envelope.
    expect(await state.accountKeys.load(state.userId)).toBeNull();
    await expect(state.accountKeys.require(state.userId)).rejects.toMatchObject({
      code: "account.key_unavailable",
    });
    expect(await db.first(sql(`SELECT COUNT(*) AS n FROM account_keys`))).toEqual({ n: 0 });
    expect(state.effects.restriction).toHaveBeenCalledWith({
      userId: state.userId,
      reason: "deleted",
      accessGeneration: 1,
      committedAt: now + 1000,
    });
    expect(state.effects.deletion).toHaveBeenCalledWith({
      userId: state.userId,
      analyticsId: "analytics-random-id",
      committedAt: now + 1000,
    });
  });

  it.each([
    ["an expired authorization", { now: now + 600_001 }],
    ["another auth session", { otherSession: true }],
    ["another user's authorization", { otherUser: true }],
    ["an unknown authorization", { unknown: true }],
  ])("refuses %s and leaves the account and its key untouched", async (_label, variant) => {
    const state = await setup([]);
    let userId = state.userId;
    if ("otherUser" in variant) {
      userId = uuidv7(now);
      await db.run(
        sql(
          `INSERT INTO users (id, email, created_at, updated_at, write_id) VALUES (:id, :email, 1, 1, 'w')`,
          { id: userId, email: "other@example.test" },
        ),
      );
    }
    const result = await state.service.delete({
      userId,
      authorizationId: "unknown" in variant ? uuidv7(now) : state.authorizationId,
      authSessionId:
        "otherSession" in variant ? state.otherSession.sessionId : state.session.sessionId,
      now: "now" in variant ? variant.now : now + 1000,
    });
    expect(result).toEqual({ status: "refused" });
    expect(await state.accountKeys.load(state.userId)).not.toBeNull();
    expect(await db.first(sql(`SELECT COUNT(*) AS n FROM account_deletions`))).toEqual({ n: 0 });
    expect(await db.first(sql(`SELECT COUNT(*) AS n FROM dispatch_intents`))).toEqual({ n: 0 });
    expect(await state.sessions.resolve(state.session.token, now + 1000)).not.toBeNull();
    expect(await db.first(sql(`SELECT consumed_at FROM account_delete_authorizations`))).toEqual({
      consumed_at: null,
    });
    expect(state.effects.restriction).not.toHaveBeenCalled();
    expect(state.effects.deletion).not.toHaveBeenCalled();
  });

  it("uses an authorization once: a replay after deletion finds no account to delete", async () => {
    const state = await setup([]);
    const request = {
      userId: state.userId,
      authorizationId: state.authorizationId,
      authSessionId: state.session.sessionId,
      now: now + 1000,
    };
    expect((await state.service.delete(request)).status).toBe("deleted");
    expect(await state.service.delete(request)).toEqual({ status: "not_found" });
    expect(state.effects.deletion).toHaveBeenCalledTimes(1);
  });
});
