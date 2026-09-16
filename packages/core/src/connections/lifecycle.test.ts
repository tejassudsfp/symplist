import { randomBytes } from "node:crypto";
import { createKeyProvider, type ManagedKeyProvider } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import type { ConnectionLifecycleProvider } from "@symplist/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { type ConnectionActor, ConnectionsService } from "./lifecycle.ts";

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
    sessions: { use: vi.fn() },
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

describe("native connection callback authority", () => {
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
