import { randomBytes } from "node:crypto";
import { createKeyProvider, keyFamilies, type ManagedKeyProvider } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountKeyStore } from "../account/keys.ts";
import {
  IDEMPOTENCY_PENDING_LEASE_MS,
  IDEMPOTENCY_RECORD_TTL_MS,
  type IdempotencyClaim,
  IdempotencyStore,
} from "./store.ts";

const now = 1_789_500_000_000;
const scope = "POST /v1/tasks";
const key = "k".repeat(24);
let db: LocalSqliteClient;
let keys: ManagedKeyProvider;
let store: IdempotencyStore;
let userId: string;

async function insertUser(): Promise<string> {
  const id = uuidv7(now);
  await db.batch([
    sql(
      `INSERT INTO users (id, email, created_at, updated_at, write_id) VALUES (:id, :email, :now, :now, 'w')`,
      { id, email: `${id}@example.test`, now: int(now) },
    ),
    new AccountKeyStore({ db, keys }).provisionStatement({ userId: id, now }),
  ]);
  return id;
}

async function started(input: unknown, at = now, owner = userId): Promise<IdempotencyClaim> {
  const result = await store.begin({ scope, userId: owner, key, input, now: at });
  if (result.kind !== "started") throw new Error(`expected started, got ${result.kind}`);
  return result.claim;
}

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
  store = new IdempotencyStore({ db, keys });
  userId = await insertUser();
});

afterEach(() => {
  db.close();
  keys.destroy();
});

describe("idempotency records (§6.1)", () => {
  it("claims a key, then replays the recorded response for an exact retry", async () => {
    const claim = await started({ title: "Plan" });
    await store.complete({ claim, response: { status: 201, body: { id: "t1" } }, now: now + 5 });
    expect(
      await store.begin({ scope, userId, key, input: { title: "Plan" }, now: now + 10 }),
    ).toEqual({
      kind: "replay",
      response: { status: 201, body: { id: "t1" } },
    });
  });

  it("records a response in one D1 request, reusing the key row the claiming batch read (§3.1)", async () => {
    const claim = await started({ title: "Budget" });
    const batch = vi.spyOn(db, "batch");
    await store.complete({ claim, response: { status: 201, body: { id: "t2" } }, now: now + 5 });
    expect(batch).toHaveBeenCalledTimes(1);
    batch.mockRestore();
    expect(
      await store.begin({ scope, userId, key, input: { title: "Budget" }, now: now + 10 }),
    ).toMatchObject({ kind: "replay", response: { status: 201, body: { id: "t2" } } });
  });

  it("stores only the fingerprint of the input and an encrypted response", async () => {
    const claim = await started({ passphrase: "correct horse battery staple" });
    await store.complete({
      claim,
      response: { status: 200, body: { note: "response marker 7f3a" } },
      now,
    });
    const row = await db.first(sql(`SELECT * FROM idempotency_records`));
    const text = JSON.stringify(row);
    expect(text).not.toContain("correct horse");
    expect(text).not.toContain("response marker");
    expect(String(row?.response_enc)).toMatch(/^sym1\.1\./);
    expect(row).toMatchObject({ status: "completed", http_status: 200, fingerprint_version: 1 });
  });

  it("returns mismatch for the same key with another input, and in progress while pending", async () => {
    await started({ title: "Plan" });
    expect(
      (await store.begin({ scope, userId, key, input: { title: "Plan" }, now: now + 1 })).kind,
    ).toBe("in_progress");
    expect(
      (await store.begin({ scope, userId, key, input: { title: "Other" }, now: now + 1 })).kind,
    ).toBe("mismatch");
  });

  it("fingerprints canonical JSON, so key order does not matter", async () => {
    const claim = await started({ a: 1, b: [1, 2] });
    await store.complete({ claim, response: { status: 200, body: null }, now });
    const retry = await store.begin({
      scope,
      userId,
      key,
      input: { b: [1, 2], a: 1 },
      now: now + 1,
    });
    expect(retry.kind).toBe("replay");
  });

  it("keeps keys separate per user and per scope", async () => {
    const other = await insertUser();
    await started({ title: "Plan" });
    expect((await store.begin({ scope, userId: other, key, input: { x: 1 }, now })).kind).toBe(
      "started",
    );
    expect(
      (await store.begin({ scope: "POST /v1/other", userId, key, input: { x: 1 }, now })).kind,
    ).toBe("started");
  });

  it("releases a failed claim so a retry runs again", async () => {
    const claim = await started({ title: "Plan" });
    await store.release(claim);
    expect(
      (await store.begin({ scope, userId, key, input: { title: "Plan" }, now: now + 1 })).kind,
    ).toBe("started");
  });

  it("lets an exact retry take over an abandoned pending claim after the lease, but never another input", async () => {
    await started({ title: "Plan" });
    const later = now + IDEMPOTENCY_PENDING_LEASE_MS;
    expect(
      (await store.begin({ scope, userId, key, input: { title: "Other" }, now: later })).kind,
    ).toBe("mismatch");
    const takeover = await store.begin({
      scope,
      userId,
      key,
      input: { title: "Plan" },
      now: later,
    });
    expect(takeover.kind).toBe("started");
  });

  it("starts over once a record expired, whatever the input", async () => {
    const claim = await started({ title: "Plan" });
    await store.complete({ claim, response: { status: 200, body: { v: 1 } }, now });
    const expired = now + IDEMPOTENCY_RECORD_TTL_MS;
    expect(
      (await store.begin({ scope, userId, key, input: { title: "New" }, now: expired })).kind,
    ).toBe("started");
    expect(await db.first(sql(`SELECT COUNT(*) AS n FROM idempotency_records`))).toEqual({ n: 1 });
  });

  it("records a response only for the claim that holds the key", async () => {
    const first = await started({ title: "Plan" }, now);
    const takeover = await started({ title: "Plan" }, now + IDEMPOTENCY_PENDING_LEASE_MS);
    await store.complete({ claim: first, response: { status: 200, body: { who: "first" } }, now });
    expect(
      (
        await store.begin({
          scope,
          userId,
          key,
          input: { title: "Plan" },
          now: now + IDEMPOTENCY_PENDING_LEASE_MS + 1,
        })
      ).kind,
    ).toBe("in_progress");
    await store.complete({
      claim: takeover,
      response: { status: 200, body: { who: "takeover" } },
      now,
    });
    expect(
      await store.begin({
        scope,
        userId,
        key,
        input: { title: "Plan" },
        now: now + IDEMPOTENCY_PENDING_LEASE_MS + 2,
      }),
    ).toEqual({ kind: "replay", response: { status: 200, body: { who: "takeover" } } });
  });

  it("guards a folded mutation with the claim, so a lost claim writes nothing", async () => {
    await db.executeScript(`CREATE TABLE probe_effects (label TEXT NOT NULL) STRICT;`);
    const claim = await started({ title: "Plan" });
    const effect = (label: string, held: IdempotencyClaim) =>
      sql(`INSERT INTO probe_effects (label) SELECT :label WHERE ${held.guard.exists}`, {
        ...held.guard.params,
        label,
      });
    const accountKey = await new AccountKeyStore({ db, keys }).require(userId);
    await db.batch([
      effect("first", claim),
      store.completeStatement({ claim, response: { status: 201, body: {} }, accountKey, now }),
    ]);
    await db.batch([effect("again", claim)]);
    expect(await db.all(sql(`SELECT label FROM probe_effects`))).toEqual([{ label: "first" }]);
  });

  it("rejects malformed scopes, keys and statuses", async () => {
    await expect(store.begin({ scope: "", userId, key, input: 1, now })).rejects.toThrow(TypeError);
    await expect(
      store.begin({ scope: "x".repeat(201), userId, key, input: 1, now }),
    ).rejects.toThrow(TypeError);
    await expect(store.begin({ scope, userId, key: "", input: 1, now })).rejects.toThrow(TypeError);
    await expect(
      store.begin({ scope, userId: uuidv7(now), key, input: 1, now }),
    ).rejects.toMatchObject({
      code: "idempotency.state_invalid",
    });
    const claim = await started({});
    await expect(
      store.complete({ claim, response: { status: 42, body: null }, now }),
    ).rejects.toThrow(TypeError);
  });
});
