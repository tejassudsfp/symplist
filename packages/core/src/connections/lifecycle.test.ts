import { randomBytes } from "node:crypto";
import { createKeyProvider, type ManagedKeyProvider } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import type { ConnectionLifecycleProvider } from "@symplist/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { IdempotencyStore, redactOneTimeSecretResponse } from "../idempotency/index.ts";
import { SimonRepository } from "../simon/repository.ts";
import type { ConnectionWriteFold } from "./fold.ts";
import { type ConnectionActor, ConnectionsService } from "./lifecycle.ts";
import { ConnectionMutations } from "./mutations.ts";

let env: DocumentsTestEnvironment;
let keys: ManagedKeyProvider;
let service: ConnectionsService;
let actor: ConnectionActor;
let provider: ConnectionLifecycleProvider;
let sequence: number;
let callbackUrl: URL;
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  sequence = 0;
  keys = createKeyProvider(
    {
      CONTENT_KEK: { current: 1, versions: new Map([[1, env.keys.current("CONTENT_KEK").key]]) },
      SESSION_DIGEST_SECRET: { current: 1, versions: new Map([[1, randomBytes(32)]]) },
      IDEMPOTENCY_SECRET: { current: 1, versions: new Map([[1, randomBytes(32)]]) },
    },
    { required: ["CONTENT_KEK", "SESSION_DIGEST_SECRET"] },
  );
  actor = await createActor();
  provider = {
    authConfigs: vi.fn(async () => ({ items: [], cursor: null })),
    createAuthConfig: vi.fn(async () => "ac_1"),
    link: vi.fn(async (_owner, _config, callback) => {
      callbackUrl = new URL(callback);
      sequence++;
      return {
        id: `ca_${sequence}`,
        url: "https://connect.composio.dev/link?token=one_time_marker",
      };
    }),
    complete: vi.fn(async () => undefined),
    account: vi.fn(async (id) => ({ id, toolkit: "gmail", status: "ACTIVE" })),
    accounts: vi.fn(async () => ({ items: [], cursor: null })),
    revoke: vi.fn(async () => undefined),
  };
  service = new ConnectionsService({
    db: env.db,
    keys,
    policy: { betaAccessRequired: true },
    now: () => env.clock,
    apiOrigin: "https://api.example.test",
    provider,
    catalogue: {
      list: async () => [{ slug: "gmail", name: "Gmail", description: "", auth: "managed" }],
    },
    sessions: {
      use: vi.fn(async () => ({
        sessionId: "sess_test",
        update: async () => undefined,
        execute: async () => ({ data: {}, error: null, logId: "log" }),
        delete: async () => undefined,
      })),
    },
    delay: async () => undefined,
  });
});
afterEach(async () => {
  keys.destroy();
  await env.close();
});

async function createActor(ownerId?: string) {
  const owner = ownerId ?? (await env.createUser());
  const session = uuidv7();
  await env.db.run(
    sql(
      `INSERT INTO auth_sessions (id,user_id,token_digest,digest_version,created_at,last_seen_at,expires_at,write_id) VALUES (:id,:owner,:id,1,:now,:now,:expiry,:id)`,
      { id: session, owner, now: int(env.clock), expiry: int(env.clock + 86400_000) },
    ),
  );
  return { ownerId: owner, sessionId: session };
}

async function begin(alias?: string) {
  const result = await service.start(actor, { toolkit: "gmail", ...(alias ? { alias } : {}) });
  return {
    attemptId: result.attemptId,
    nonce: callbackUrl.searchParams.get("n") ?? "",
    sessionUri: "attestation_token",
  };
}

function fold(requestId: string, oneTime = true): ConnectionWriteFold {
  const store = new IdempotencyStore({ db: env.db, keys });
  const request = {
    scope: "POST /connections",
    userId: actor.ownerId,
    key: requestId,
    input: { toolkit: "gmail" },
    now: env.clock,
  };
  const folded = store.foldedClaim(request);
  return {
    ...folded,
    completionStatement: (response, accountKey) =>
      store.completeStatement({
        claim: folded.claim,
        accountKey,
        now: env.clock,
        response: oneTime
          ? { status: 200, body: redactOneTimeSecretResponse(response.body, ["url"]) }
          : response,
      }),
    decide: (results, accountKey) => {
      const result = store.decideFoldedClaim({ request, folded, results, accountKey });
      if (result.kind === "replay") return { kind: "replay", body: result.response.body };
      if (result.kind !== "started") throw new Error(result.kind);
      return result;
    },
  };
}

function mutations() {
  return new ConnectionMutations({
    repository: new SimonRepository({
      db: env.db,
      keys,
      now: () => env.clock,
      policy: { betaAccessRequired: true },
      quickChatTtlHours: 24,
    }),
    provider,
    sessions: service.options.sessions,
  });
}

describe("native connection callback authority", () => {
  it("rechecks the connection capacity at confirmation instead of overflowing the bounded inventory", async () => {
    const attempt = await begin();
    await env.db.run(
      sql(
        `INSERT INTO connections (id, owner_id, toolkit, connected_account_id, status, confirmed_at, created_at, updated_at, write_id)
       SELECT value, :owner, 'gmail', 'ca_capacity_' || value, 'active', 1, 1, 1, value FROM json_each(:ids)`,
        { owner: actor.ownerId, ids: JSON.stringify(Array.from({ length: 500 }, () => uuidv7())) },
      ),
    );
    await expect(service.callback(actor, attempt)).rejects.toMatchObject({
      code: "integration.unauthorized",
    });
    expect(await env.count("connections")).toBe(500);
    expect(await service.list(actor)).toHaveLength(500);
    expect(provider.revoke).toHaveBeenCalledWith("ca_1");
  });
  it("reconnects the exact version of an existing connection while preserving its encrypted alias", async () => {
    const id = await service.callback(actor, await begin("Work"));
    const next = await service.start(actor, { toolkit: "gmail", replacesConnectionId: id });
    expect(
      await service.callback(actor, {
        attemptId: next.attemptId,
        nonce: callbackUrl.searchParams.get("n") ?? "",
        sessionUri: "new_attestation",
      }),
    ).toBe(id);
    expect(await env.count("connections")).toBe(1);
    expect((await service.list(actor))[0]).toMatchObject({ id, alias: "Work", status: "active" });
    expect(
      await env.db.first(
        sql("SELECT connected_account_id, generation FROM connections WHERE id = :id", { id }),
      ),
    ).toEqual({ connected_account_id: "ca_2", generation: 2 });
    expect(
      await env.db.first(sql("SELECT connected_account_id FROM connection_revoke_jobs")),
    ).toEqual({ connected_account_id: "ca_1" });
  });

  it("refuses a stale reconnect after a concurrent disconnect", async () => {
    const id = await service.callback(actor, await begin());
    const next = await service.start(actor, { toolkit: "gmail", replacesConnectionId: id });
    await mutations().disconnect(actor, id);
    await expect(
      service.callback(actor, {
        attemptId: next.attemptId,
        nonce: callbackUrl.searchParams.get("n") ?? "",
        sessionUri: "new_attestation",
      }),
    ).rejects.toThrow("integration.unauthorized");
    expect(
      await env.db.first(
        sql("SELECT connected_account_id, status FROM connections WHERE id = :id", { id }),
      ),
    ).toEqual({ connected_account_id: "ca_1", status: "disconnected" });
    expect(provider.revoke).toHaveBeenCalledWith("ca_2");
  });

  it("folds the attempt and redacted outcome before issuing one hosted link", async () => {
    const request = uuidv7();
    const initial = await service.start(actor, { toolkit: "gmail" }, fold(request));
    const replay = await service.start(actor, { toolkit: "gmail" }, fold(request));
    expect(initial.url).toContain("one_time_marker");
    expect(replay).toEqual({
      attemptId: initial.attemptId,
      expiresAt: initial.expiresAt,
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
    expect(provider.link).toHaveBeenCalledTimes(1);
    expect(await env.count("connection_attempts")).toBe(1);
    expect(
      JSON.stringify(await env.db.all(sql("SELECT * FROM idempotency_records"))),
    ).not.toContain("one_time_marker");
  });

  it("does not save an idempotent success when the outstanding-attempt capacity refuses the effect", async () => {
    for (let i = 0; i < 5; i++) await begin();
    await expect(service.start(actor, { toolkit: "gmail" }, fold(uuidv7()))).rejects.toThrow(
      "integration.unavailable",
    );
    expect(await env.count("idempotency_records")).toBe(0);
  });

  it("does not replay a previously admitted attempt after relock", async () => {
    const request = uuidv7();
    await service.start(actor, { toolkit: "gmail" }, fold(request));
    await env.relock(actor.ownerId);
    await expect(service.start(actor, { toolkit: "gmail" }, fold(request))).rejects.toThrow(
      "integration.unauthorized",
    );
    expect(provider.link).toHaveBeenCalledTimes(1);
  });
  it("confirms only after identity attestation, stores encrypted aliases and never stores callback/link secrets", async () => {
    const input = await begin("private_alias_marker");
    expect(await service.list(actor)).toEqual([]);
    const id = await service.callback(actor, input);
    expect(provider.complete).toHaveBeenCalledWith("attestation_token", actor.ownerId);
    expect(provider.account).toHaveBeenCalledWith("ca_1");
    expect(await service.list(actor)).toEqual([
      {
        id,
        toolkit: "gmail",
        alias: "private_alias_marker",
        status: "active",
        approvalMode: "all",
        createdAt: env.clock,
      },
    ]);
    const rows = await env.db.batch([
      sql("SELECT * FROM connection_attempts"),
      sql("SELECT * FROM connections"),
    ]);
    const serialized = JSON.stringify(rows);
    for (const marker of [
      input.nonce,
      "attestation_token",
      "private_alias_marker",
      "one_time_marker",
    ])
      expect(serialized).not.toContain(marker);
    expect(serialized).toContain("sym1.");
    expect(service.options.sessions.use).toHaveBeenCalledWith(actor.ownerId);
  });

  it("binds callbacks to the exact initiating login session", async () => {
    const input = await begin();
    const secondSession = await createActor(actor.ownerId);
    await expect(service.callback(secondSession, input)).rejects.toThrow(
      "integration.unauthorized",
    );
    expect(provider.complete).not.toHaveBeenCalled();
    await service.callback(actor, input);
  });

  it("rejects cross-user callbacks and lists", async () => {
    const input = await begin();
    const stranger = await createActor();
    await expect(service.callback(stranger, input)).rejects.toThrow("integration.unauthorized");
    await service.callback(actor, input);
    expect(await service.list(stranger)).toEqual([]);
  });

  it("requires a single-use nonce and never repeats the provider attestation", async () => {
    const input = await begin();
    await expect(
      service.callback(actor, { ...input, nonce: randomBytes(32).toString("base64url") }),
    ).rejects.toThrow("integration.unauthorized");
    await service.callback(actor, input);
    await expect(service.callback(actor, input)).rejects.toThrow("integration.unauthorized");
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it.each(["expiry", "logout", "relock", "shred"])(
    "rejects %s before upstream attestation",
    async (kind) => {
      const input = await begin();
      if (kind === "expiry") env.clock += 600_001;
      if (kind === "logout")
        await env.db.run(
          sql("UPDATE auth_sessions SET revoked_at = :now WHERE id = :session", {
            now: int(env.clock),
            session: actor.sessionId,
          }),
        );
      if (kind === "relock") await env.relock(actor.ownerId);
      if (kind === "shred")
        await env.db.run(
          sql("DELETE FROM account_keys WHERE owner_id = :owner", { owner: actor.ownerId }),
        );
      await expect(service.callback(actor, input)).rejects.toThrow("integration.unauthorized");
      expect(provider.complete).not.toHaveBeenCalled();
    },
  );

  it.each([
    { id: "ca_other", toolkit: "gmail", status: "ACTIVE" },
    { id: "ca_1", toolkit: "other", status: "ACTIVE" },
    { id: "ca_1", toolkit: "gmail", status: "FAILED" },
  ])("refuses provider identity substitution/inactive state %j", async (account) => {
    const input = await begin();
    vi.mocked(provider.account).mockResolvedValue(account);
    await expect(service.callback(actor, input)).rejects.toThrow();
    expect(await env.count("connections")).toBe(0);
    expect(provider.revoke).toHaveBeenCalledWith("ca_1");
  });

  it("cannot publish a connection when access is revoked during provider verification", async () => {
    const input = await begin();
    vi.mocked(provider.complete).mockImplementationOnce(async () => {
      await env.relock(actor.ownerId);
    });
    await expect(service.callback(actor, input)).rejects.toThrow("integration.unauthorized");
    expect(await env.count("connections")).toBe(0);
    expect(provider.revoke).toHaveBeenCalledWith("ca_1");
  });

  it("backoffs only for initializing accounts, then confirms", async () => {
    const input = await begin();
    vi.mocked(provider.account).mockResolvedValueOnce({
      id: "ca_1",
      toolkit: "gmail",
      status: "INITIALIZING",
    });
    await service.callback(actor, input);
    expect(provider.account).toHaveBeenCalledTimes(2);
  });

  it("does not revoke a successfully confirmed account when pin publication temporarily fails", async () => {
    const input = await begin();
    vi.mocked(service.options.sessions.use).mockRejectedValue(new Error("unavailable"));
    await expect(service.callback(actor, input)).rejects.toThrow("unavailable");
    expect(await env.count("connections")).toBe(1);
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it("limits outstanding attempts before making another hosted link", async () => {
    for (let i = 0; i < 5; i++) await begin();
    await expect(begin()).rejects.toThrow("integration.unavailable");
    expect(provider.link).toHaveBeenCalledTimes(5);
  });

  it("refuses a toolkit missing from the live supported catalogue", async () => {
    await expect(service.start(actor, { toolkit: "unknown" })).rejects.toThrow(
      "integration.tool_unavailable",
    );
    expect(provider.link).not.toHaveBeenCalled();
  });
});

describe("connection disconnect and durable provider cleanup", () => {
  it("revokes native authority before the provider is called and clears its cleanup intent only on success", async () => {
    const id = await service.callback(actor, await begin());
    vi.mocked(provider.revoke).mockImplementationOnce(async () => {
      expect(
        await env.db.first(
          sql("SELECT status, generation FROM connections WHERE id = :id", { id }),
        ),
      ).toEqual({ status: "disconnected", generation: 2 });
      expect(await env.count("connection_revoke_jobs")).toBe(1);
    });
    expect(await mutations().disconnect(actor, id)).toEqual({ id, status: "disconnected" });
    expect(provider.revoke).toHaveBeenCalledWith("ca_1");
    expect(await env.count("connection_revoke_jobs")).toBe(0);
  });

  it("retains provider cleanup across an outage and fences concurrent attempts", async () => {
    const id = await service.callback(actor, await begin());
    const changes = mutations();
    vi.mocked(provider.revoke).mockRejectedValueOnce(new Error("outage"));
    await changes.disconnect(actor, id);
    expect(await env.count("connection_revoke_jobs")).toBe(1);
    await changes.finishRevocation(actor.ownerId, "ca_1");
    expect(provider.revoke).toHaveBeenCalledTimes(1);
    env.clock += 60_001;
    await changes.finishRevocation(actor.ownerId, "ca_1");
    expect(provider.revoke).toHaveBeenCalledTimes(2);
    expect(await env.count("connection_revoke_jobs")).toBe(0);
  });

  it("rejects cross-user and logged-out disconnects before any provider call", async () => {
    const id = await service.callback(actor, await begin());
    await expect(mutations().disconnect(await createActor(), id)).rejects.toThrow(
      "integration.unauthorized",
    );
    await env.db.run(
      sql("UPDATE auth_sessions SET revoked_at = :now WHERE id = :session", {
        now: int(env.clock),
        session: actor.sessionId,
      }),
    );
    await expect(mutations().disconnect(actor, id)).rejects.toThrow("integration.unauthorized");
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it("folds disconnect idempotency and never re-revokes a replay", async () => {
    const id = await service.callback(actor, await begin());
    const request = uuidv7();
    const changes = mutations();
    await changes.disconnect(actor, id, fold(request, false));
    await changes.disconnect(actor, id, fold(request, false));
    expect(provider.revoke).toHaveBeenCalledTimes(1);
    expect(
      await env.db.first(sql("SELECT generation FROM connections WHERE id = :id", { id })),
    ).toEqual({ generation: 2 });
  });
});

describe("per-connection approval preference", () => {
  it("asks by default, changes one account only, and never touches the connection generation", async () => {
    const first = await service.callback(actor, await begin("Work"));
    const second = await service.callback(actor, await begin("Personal"));
    expect((await service.list(actor)).map((entry) => entry.approvalMode)).toEqual(["all", "all"]);

    expect(await mutations().setApprovalMode(actor, first, "reads")).toEqual({
      id: first,
      approvalMode: "reads",
    });
    expect(
      Object.fromEntries((await service.list(actor)).map((row) => [row.id, row.approvalMode])),
    ).toEqual({ [first]: "reads", [second]: "all" });
    // A preference is not an authority change, so approvals already waiting stay exactly as issued.
    expect(
      await env.db.first(sql("SELECT generation FROM connections WHERE id = :id", { id: first })),
    ).toEqual({ generation: 1 });

    expect(await mutations().setApprovalMode(actor, first, "all")).toEqual({
      id: first,
      approvalMode: "all",
    });
    expect((await service.list(actor)).map((entry) => entry.approvalMode)).toEqual(["all", "all"]);
  });

  it("refuses cross-user, disconnected and logged-out changes", async () => {
    const id = await service.callback(actor, await begin());
    await expect(mutations().setApprovalMode(await createActor(), id, "reads")).rejects.toThrow(
      "integration.unauthorized",
    );
    expect(
      await env.db.first(sql("SELECT approval_mode FROM connections WHERE id = :id", { id })),
    ).toEqual({ approval_mode: null });

    const other = await service.callback(actor, await begin());
    await mutations().disconnect(actor, id);
    await expect(mutations().setApprovalMode(actor, id, "reads")).rejects.toThrow(
      "integration.unauthorized",
    );

    await env.db.run(
      sql("UPDATE auth_sessions SET revoked_at = :now WHERE id = :session", {
        now: int(env.clock),
        session: actor.sessionId,
      }),
    );
    await expect(mutations().setApprovalMode(actor, other, "reads")).rejects.toThrow(
      "integration.unauthorized",
    );
  });

  it("folds idempotency so a retried change replays instead of applying twice", async () => {
    const id = await service.callback(actor, await begin());
    const request = uuidv7();
    const changes = mutations();
    expect(await changes.setApprovalMode(actor, id, "reads", fold(request, false))).toEqual({
      id,
      approvalMode: "reads",
    });
    await changes.setApprovalMode(actor, id, "all", fold(request, false));
    expect(
      await env.db.first(sql("SELECT approval_mode FROM connections WHERE id = :id", { id })),
    ).toEqual({ approval_mode: "reads" });
  });
});
