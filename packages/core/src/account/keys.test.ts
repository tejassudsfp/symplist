import { randomBytes } from "node:crypto";
import {
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountKeyStore } from "./keys.ts";

const now = 1_789_500_000_000;
let db: LocalSqliteClient;
let keys: ManagedKeyProvider;

const field = (ownerId: string) => ({
  purpose: "title",
  ownerId,
  table: "tasks",
  rowId: "t1",
  column: "title_enc",
});

beforeEach(async () => {
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  keys = createKeyProvider(
    Object.fromEntries(
      keyFamilies.map((family) => [
        family,
        { current: 1, versions: new Map([[1, randomBytes(32)]]) },
      ]),
    ),
  );
});

afterEach(() => {
  db.close();
  keys.destroy();
});

function insertUser(id: string) {
  return sql(
    `INSERT INTO users (id, email, created_at, updated_at, write_id) VALUES (:id, :email, :now, :now, :w)`,
    { id, email: `${id}@example.test`, now: int(now), w: uuidv7(now) },
  );
}

describe("account key provisioning (§4.1)", () => {
  it("provisions the key in the batch that creates the user, wrapped and never stored in the clear", async () => {
    const store = new AccountKeyStore({ db, keys });
    const userId = uuidv7(now);
    await db.batch([insertUser(userId), store.provisionStatement({ userId, now })]);
    const row = await db.first(
      sql(`SELECT * FROM account_keys WHERE owner_id = :id`, { id: userId }),
    );
    expect(row).toMatchObject({ owner_id: userId, kek_version: 1 });
    expect(typeof row?.wrapped_key).toBe("string");
    const key = await store.require(userId);
    expect(key.ownerId).toBe(userId);
    expect(String(row?.wrapped_key)).not.toContain(Buffer.from(key.key).toString("base64url"));
  });

  it("is idempotent: provisioning again keeps the first key, so existing envelopes stay readable", async () => {
    const store = new AccountKeyStore({ db, keys });
    const userId = uuidv7(now);
    await db.batch([insertUser(userId), store.provisionStatement({ userId, now })]);
    const envelope = encryptFieldText(await store.require(userId), field(userId), "keep me");
    await db.run(store.provisionStatement({ userId, now: now + 1 }));
    const ensured = await store.ensure({ userId, now: now + 2 });
    expect(decryptFieldText(ensured, field(userId), envelope)).toBe("keep me");
    expect(await db.first(sql(`SELECT COUNT(*) AS n FROM account_keys`))).toEqual({ n: 1 });
  });

  it("writes nothing for a missing user and reports the key as unavailable", async () => {
    const store = new AccountKeyStore({ db, keys });
    const missing = uuidv7(now);
    await db.run(store.provisionStatement({ userId: missing, now }));
    expect(await store.load(missing)).toBeNull();
    await expect(store.ensure({ userId: missing, now })).rejects.toMatchObject({
      code: "account.key_unavailable",
    });
  });

  it("gives every account its own key", async () => {
    const store = new AccountKeyStore({ db, keys });
    const a = uuidv7(now);
    const b = uuidv7(now + 1);
    await db.batch([
      insertUser(a),
      insertUser(b),
      store.provisionStatement({ userId: a, now }),
      store.provisionStatement({ userId: b, now }),
    ]);
    const envelope = encryptFieldText(await store.require(a), field(a), "secret");
    const other = await store.require(b);
    expect(Buffer.from(other.key).equals(Buffer.from((await store.require(a)).key))).toBe(false);
    expect(() => decryptFieldText(other, field(b), envelope)).toThrow();
  });
});
