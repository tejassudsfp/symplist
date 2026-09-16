import { int, sql, uuidv7 } from "@symplist/db";
import {
  type ConnectionLifecycleProvider,
  type ProviderAccount,
  unavailableConnectionProvider,
} from "@symplist/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { SimonRepository } from "../simon/repository.ts";
import { ConnectionReconciler } from "./reconcile.ts";

let env: DocumentsTestEnvironment;
let owner: string;
let reconciler: ConnectionReconciler;
let provider: ConnectionLifecycleProvider;
let accounts: ProviderAccount[];
const fence = { mode: "durable" as const, generation: 3 };
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  owner = await env.createUser();
  accounts = [];
  provider = {
    ...unavailableConnectionProvider(),
    accounts: vi.fn(async () => ({ items: accounts, cursor: null })),
    revoke: vi.fn(async () => undefined),
  };
  reconciler = new ConnectionReconciler({
    repository: new SimonRepository({
      db: env.db,
      keys: env.keys,
      now: () => env.clock,
      policy: { betaAccessRequired: true },
      quickChatTtlHours: 24,
    }),
    provider,
    sessions: {
      use: vi.fn(async () => ({
        sessionId: "session",
        update: async () => undefined,
        execute: async () => ({ data: {}, error: null, logId: "log" }),
        delete: async () => undefined,
      })),
    },
    changed: vi.fn(async () => undefined),
  });
  await env.db.run(sql("UPDATE executor_state SET mode = 'durable', generation = 3 WHERE id = 1"));
});
afterEach(async () => env.close());

async function native(account = "ca_owned", user = owner) {
  const id = uuidv7();
  await env.db.run(
    sql(
      `INSERT INTO connections (id,owner_id,toolkit,connected_account_id,status,confirmed_at,created_at,updated_at,write_id) VALUES (:id,:owner,'gmail',:account,'active',:now,:now,:now,:id)`,
      { id, owner: user, account, now: int(env.clock) },
    ),
  );
  return id;
}

async function attempt(account: string, expired = false) {
  const session = uuidv7();
  const id = uuidv7();
  await env.db.batch([
    sql(
      `INSERT INTO auth_sessions (id,user_id,token_digest,digest_version,created_at,last_seen_at,expires_at,write_id) VALUES (:id,:owner,:id,1,:now,:now,:expiry,:id)`,
      { id: session, owner, now: int(env.clock), expiry: int(env.clock + 600_000) },
    ),
    sql(
      `INSERT INTO connection_attempts (id,user_id,auth_session_id,toolkit,nonce_digest,connected_account_id,expires_at,status,created_at,updated_at,write_id) VALUES (:id,:owner,:session,'gmail','digest',:account,:expiry,'completing',:now,:now,:id)`,
      {
        id,
        owner,
        session,
        account,
        expiry: int(env.clock + (expired ? -1 : 600_000)),
        now: int(env.clock),
      },
    ),
  ]);
}

describe("generation-fenced connection reconciliation", () => {
  it("runs the complete current-generation owner scan and expires old attempts", async () => {
    await native();
    await attempt("ca_expired", true);
    accounts = [
      { id: "ca_owned", toolkit: "gmail", status: "EXPIRED" },
      { id: "ca_expired", toolkit: "gmail", status: "ACTIVE" },
    ];
    expect(await reconciler.run(fence)).toEqual({ owners: 1, updated: 1, revoked: 1 });
    expect(
      await env.db.first(
        sql("SELECT status FROM connection_attempts WHERE connected_account_id = 'ca_expired'"),
      ),
    ).toEqual({ status: "expired" });
  });
  it.each(["EXPIRED", "FAILED", "REVOKED", "INACTIVE"])(
    "maps %s without trusting another owner's account",
    async (status) => {
      const id = await native();
      const other = await env.createUser();
      const foreign = await native("ca_foreign", other);
      accounts = [
        { id: "ca_owned", toolkit: "gmail", status },
        { id: "ca_foreign", toolkit: "gmail", status },
      ];
      expect(await reconciler.owner(owner, fence)).toBe(1);
      expect(
        await env.db.first(sql("SELECT status,generation FROM connections WHERE id = :id", { id })),
      ).toEqual({ status: "needs_attention", generation: 2 });
      expect(
        await env.db.first(
          sql("SELECT status,generation FROM connections WHERE id = :id", { id: foreign }),
        ),
      ).toEqual({ status: "active", generation: 1 });
      expect(reconciler.options.changed).toHaveBeenCalledWith(owner, id);
      expect(reconciler.options.sessions.use).toHaveBeenCalledOnce();
      expect(await reconciler.owner(owner, fence)).toBe(0);
      expect(reconciler.options.changed).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects an old executor before contacting the provider", async () => {
    await native();
    expect(await reconciler.run({ mode: "local", generation: 2 })).toEqual({
      owners: 0,
      updated: 0,
      revoked: 0,
    });
    expect(provider.accounts).not.toHaveBeenCalled();
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it("refuses publication if the mode changes during provider I/O", async () => {
    const id = await native();
    provider.accounts = vi.fn(async () => {
      await env.db.run(
        sql("UPDATE executor_state SET mode = 'local', generation = 4 WHERE id = 1"),
      );
      return {
        items: [
          { id: "ca_owned", toolkit: "gmail", status: "EXPIRED" },
          { id: "ca_unknown", toolkit: "gmail", status: "ACTIVE" },
        ],
        cursor: null,
      };
    });
    expect(await reconciler.owner(owner, fence)).toBe(0);
    expect(await env.count("connection_revoke_jobs")).toBe(0);
    expect(
      await env.db.first(sql("SELECT status FROM connections WHERE id = :id", { id })),
    ).toEqual({ status: "active" });
  });

  it("protects pending callback attestation, but cleans abandoned and expired ACTIVE accounts", async () => {
    await native();
    await attempt("ca_pending");
    await attempt("ca_expired", true);
    accounts = ["ca_owned", "ca_pending", "ca_expired", "ca_unconfirmed"].map((id) => ({
      id,
      toolkit: "gmail",
      status: "ACTIVE",
    }));
    await reconciler.owner(owner, fence);
    expect(await reconciler.drain(fence)).toBe(2);
    expect(provider.revoke).toHaveBeenCalledWith("ca_expired");
    expect(provider.revoke).toHaveBeenCalledWith("ca_unconfirmed");
    expect(provider.revoke).not.toHaveBeenCalledWith("ca_owned");
    expect(provider.revoke).not.toHaveBeenCalledWith("ca_pending");
    expect(await env.count("connection_revoke_jobs")).toBe(0);
  });

  it("rechecks confirmed native authority at the cleanup claim", async () => {
    accounts = [{ id: "ca_late", toolkit: "gmail", status: "ACTIVE" }];
    await reconciler.owner(owner, fence);
    await native("ca_late");
    expect(await reconciler.drain(fence)).toBe(0);
    expect(provider.revoke).not.toHaveBeenCalled();
  });
  it("stops scheduling cleanup batches after an executor mode switch", async () => {
    accounts = Array.from({ length: 20 }, (_, n) => ({
      id: `ca_${n}`,
      toolkit: "gmail",
      status: "ACTIVE",
    }));
    await reconciler.owner(owner, fence);
    provider.revoke = vi.fn(async () => {
      await env.db.run(
        sql("UPDATE executor_state SET mode = 'local', generation = 4 WHERE id = 1"),
      );
    });
    expect(await reconciler.drain(fence)).toBe(5);
    expect(provider.revoke).toHaveBeenCalledTimes(5);
    // Even completed deletes cannot be acknowledged under the retired generation. Idempotent
    // provider deletion is retried by the new executor after the leases expire.
    expect(await env.count("connection_revoke_jobs")).toBe(20);
  });

  it("keeps failed cleanup for retry without repeating a live lease", async () => {
    accounts = [{ id: "ca_unknown", toolkit: "gmail", status: "ACTIVE" }];
    await reconciler.owner(owner, fence);
    provider.revoke = vi.fn(async () => {
      throw new Error("private provider body");
    });
    expect(await reconciler.drain(fence)).toBe(0);
    expect(await reconciler.drain(fence)).toBe(0);
    expect(provider.revoke).toHaveBeenCalledOnce();
    expect(await env.count("connection_revoke_jobs")).toBe(1);
    env.clock += 60_001;
    provider.revoke = vi.fn(async () => undefined);
    expect(await reconciler.drain(fence)).toBe(1);
  });

  it("caps cleanup to twenty ids per claim and does not send D1 per provider call", async () => {
    accounts = Array.from({ length: 45 }, (_, n) => ({
      id: `ca_${n}`,
      toolkit: "gmail",
      status: "ACTIVE",
    }));
    await reconciler.owner(owner, fence);
    const batch = vi.spyOn(env.db, "batch");
    expect(await reconciler.drain(fence)).toBe(20);
    expect(await env.count("connection_revoke_jobs")).toBe(25);
    expect(provider.revoke).toHaveBeenCalledTimes(20);
    expect(
      batch.mock.calls.filter(([statements]) =>
        statements.some((entry) => entry.sql.includes("DELETE FROM connection_revoke_jobs")),
      ),
    ).toHaveLength(1);
  });

  it("rejects cycling provider pages before publishing any effects", async () => {
    await native();
    provider.accounts = vi.fn(async () => ({
      items: [{ id: "ca_owned", toolkit: "gmail", status: "EXPIRED" }],
      cursor: "again",
    }));
    await expect(reconciler.owner(owner, fence)).rejects.toThrow("integration.invalid_response");
    expect(provider.accounts).toHaveBeenCalledTimes(2);
    expect(reconciler.options.changed).not.toHaveBeenCalled();
  });

  it("uses multiple bounded mutation batches for populated owners", async () => {
    for (let i = 0; i < 19; i++) await native(`ca_${i}`);
    accounts = Array.from({ length: 19 }, (_, n) => ({
      id: `ca_${n}`,
      toolkit: "gmail",
      status: "EXPIRED",
    }));
    const batch = vi.spyOn(env.db, "batch");
    expect(await reconciler.owner(owner, fence)).toBe(19);
    const writes = batch.mock.calls.filter(([statements]) =>
      statements.some((entry) => entry.sql.includes("UPDATE connections")),
    );
    expect(writes).toHaveLength(3);
    expect(
      writes.every(
        ([statements]) =>
          statements.length <= 49 && statements.every((entry) => entry.params.length <= 100),
      ),
    ).toBe(true);
  });
});
