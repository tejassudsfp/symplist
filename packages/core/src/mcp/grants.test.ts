import { randomBytes } from "node:crypto";
import { createKeyProvider, type ManagedKeyProvider } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpRestrictContributor } from "../access/restrict-contributors/mcp.ts";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { IdempotencyStore, redactOneTimeSecretResponse } from "../idempotency/index.ts";
import { McpGrants, type McpOwner, type McpWriteFold, mcpAuthorization } from "./grants.ts";

let env: DocumentsTestEnvironment;
let keys: ManagedKeyProvider;
let grants: McpGrants;
let actor: McpOwner;
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  keys = createKeyProvider(
    {
      CONTENT_KEK: { current: 1, versions: new Map([[1, env.keys.current("CONTENT_KEK").key]]) },
      MCP_TOKEN_DIGEST_SECRET: { current: 1, versions: new Map([[1, randomBytes(32)]]) },
      IDEMPOTENCY_SECRET: { current: 1, versions: new Map([[1, randomBytes(32)]]) },
    },
    { required: ["CONTENT_KEK", "MCP_TOKEN_DIGEST_SECRET", "IDEMPOTENCY_SECRET"] },
  );
  actor = { ownerId: await env.createUser(), sessionId: uuidv7() };
  await env.db.run(
    sql(
      `INSERT INTO auth_sessions (id,user_id,token_digest,digest_version,created_at,last_seen_at,expires_at,write_id) VALUES (:id,:owner,:id,1,:now,:now,:expiry,:id)`,
      {
        id: actor.sessionId,
        owner: actor.ownerId,
        now: int(env.clock),
        expiry: int(env.clock + 86400_000),
      },
    ),
  );
  grants = new McpGrants({
    db: env.db,
    keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
  });
});
afterEach(async () => {
  keys.destroy();
  await env.close();
});

function fold(id: string): McpWriteFold {
  const store = new IdempotencyStore({ db: env.db, keys });
  const request = {
    scope: "POST /mcp/keys",
    userId: actor.ownerId,
    key: id,
    input: { name: "private_client_marker" },
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
        response: {
          status: response.status,
          body: redactOneTimeSecretResponse(response.body, ["key"]),
        },
      }),
    decide: (results, accountKey) => {
      const result = store.decideFoldedClaim({ request, folded, results, accountKey });
      if (result.kind === "replay") return { kind: "replay", body: result.response.body };
      if (result.kind !== "started") throw new Error(result.kind);
      return result;
    },
  };
}
async function mint(taskIds: readonly string[] | null = null) {
  return grants.createKey(actor, {
    name: "private_client_marker",
    scopes: ["tasks:read"],
    taskIds: taskIds === null ? null : [...taskIds],
  });
}

describe("MCP grant authority and one-time API keys", () => {
  it("binds verified OAuth claims to the exact owner, client, generation and stored scope", async () => {
    const issued = await mint();
    const original = await grants.authenticateKey(issued.key ?? "");
    await env.db.run(
      sql(
        "UPDATE mcp_grants SET kind = 'oauth', client_id = 'client', key_digest = NULL, digest_version = NULL WHERE id = :id",
        { id: issued.id },
      ),
    );
    const expected = { ...original, kind: "oauth" as const, clientId: "client" };
    expect(await grants.authenticateOAuth(expected)).toEqual(expected);
    for (const altered of [
      { ...expected, clientId: "other" },
      { ...expected, ownerId: await env.createUser() },
      { ...expected, generation: 2 },
      { ...expected, scopes: ["tasks:write" as const] },
      { ...expected, taskIds: [uuidv7()] },
    ])
      await expect(grants.authenticateOAuth(altered)).rejects.toThrow("mcp.invalid_token");
    await env.relock(actor.ownerId);
    await expect(grants.authenticateOAuth(expected)).rejects.toThrow("mcp.invalid_token");
  });
  it("mints a 32-byte key once, stores only its digest and encrypted name, and redacts replay", async () => {
    const request = uuidv7();
    const first = await grants.createKey(
      actor,
      { name: "private_client_marker", scopes: ["tasks:read"], taskIds: null },
      fold(request),
    );
    expect(first.key).toMatch(/^sym_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/);
    const replay = await grants.createKey(
      actor,
      { name: "private_client_marker", scopes: ["tasks:read"], taskIds: null },
      fold(request),
    );
    expect(replay).toEqual({
      id: first.id,
      expiresAt: first.expiresAt,
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
    expect(await env.count("mcp_grants")).toBe(1);
    const rows = await env.db.all(sql("SELECT * FROM mcp_grants"));
    const responses = await env.db.all(sql("SELECT * FROM idempotency_records"));
    const persisted = JSON.stringify([rows, responses]);
    expect(persisted).not.toContain(first.key);
    expect(persisted).not.toContain("private_client_marker");
    expect(rows[0]?.client_name_enc).toMatch(/^sym1\./);
    expect(await grants.list(actor)).toEqual([
      expect.objectContaining({
        id: first.id,
        name: "private_client_marker",
        scopes: ["tasks:read"],
        taskIds: null,
      }),
    ]);
    expect(JSON.stringify(await grants.list(actor))).not.toContain("key_digest");
  });

  it("authenticates the owner, checks the digest, and writes last-used no more than every ten minutes", async () => {
    const issued = await mint();
    const writes = vi.spyOn(env.db, "run");
    const identity = await grants.authenticateKey(issued.key ?? "");
    expect(identity).toMatchObject({
      id: issued.id,
      ownerId: actor.ownerId,
      generation: 1,
      scopes: ["tasks:read"],
    });
    await grants.authenticateKey(issued.key ?? "");
    expect(writes).toHaveBeenCalledTimes(1);
    env.clock += 600_000;
    await grants.authenticateKey(issued.key ?? "");
    expect(writes).toHaveBeenCalledTimes(2);
    await expect(
      grants.authenticateKey(`sym_${issued.id}_${randomBytes(32).toString("base64url")}`),
    ).rejects.toThrow("mcp.invalid_token");
  });

  it("negative-caches only unknown ids and rejects malformed tokens before D1", async () => {
    const first = vi.spyOn(env.db, "first");
    await expect(grants.authenticateKey("not-a-key")).rejects.toThrow("mcp.invalid_token");
    expect(first).not.toHaveBeenCalled();
    const token = `sym_${uuidv7()}_${randomBytes(32).toString("base64url")}`;
    await expect(grants.authenticateKey(token)).rejects.toThrow("mcp.invalid_token");
    await expect(grants.authenticateKey(token)).rejects.toThrow("mcp.invalid_token");
    expect(first).toHaveBeenCalledTimes(1);
    env.clock += 60_001;
    await expect(grants.authenticateKey(token)).rejects.toThrow("mcp.invalid_token");
    expect(first).toHaveBeenCalledTimes(2);
  });

  it("requires exact selected task ownership and keeps creation under D1's parameter cap", async () => {
    const task = await env.createTask(actor.ownerId);
    const foreign = await env.createTask(await env.createUser());
    await expect(mint([task, foreign])).rejects.toThrow("mcp.conflict");
    expect(await env.count("mcp_grants")).toBe(0);
    const key = await mint([task]);
    const identity = await grants.authenticateKey(key.key ?? "");
    await expect(grants.require(identity, "tasks:read", [task])).resolves.toBeUndefined();
    await expect(grants.require(identity, "tasks:read", [foreign])).rejects.toThrow(
      "mcp.forbidden",
    );
    await expect(grants.require(identity, "tasks:write", [task])).rejects.toThrow("mcp.forbidden");
    await expect(grants.require(identity, "tasks:read", null)).rejects.toThrow("mcp.forbidden");
    const predicate = mcpAuthorization(
      identity,
      "tasks:read",
      env.clock,
      Array.from({ length: 100 }, () => uuidv7()),
      "task_auth_",
    );
    expect(sql(predicate.sql, predicate.params).params.length).toBeLessThan(100);
    expect(Object.keys(predicate.params).every((name) => name.startsWith("task_auth_"))).toBe(true);
  });

  it("allows write permission to include reads but not AI work", async () => {
    const issued = await grants.createKey(actor, {
      name: "Editor",
      scopes: ["tasks:write"],
      taskIds: null,
    });
    const identity = await grants.authenticateKey(issued.key ?? "");
    await expect(grants.require(identity, "tasks:read", [])).resolves.toBeUndefined();
    await expect(grants.require(identity, "ai:run", [])).rejects.toThrow("mcp.forbidden");
  });

  it("refuses authorization at the exact expiry and after generation changes", async () => {
    const issued = await mint();
    const identity = await grants.authenticateKey(issued.key ?? "");
    await env.db.run(
      sql("UPDATE mcp_grants SET generation = generation + 1 WHERE id = :id", { id: issued.id }),
    );
    await expect(grants.require(identity, "tasks:read", [])).rejects.toThrow("mcp.forbidden");
    env.clock = issued.expiresAt;
    await expect(grants.authenticateKey(issued.key ?? "")).rejects.toThrow("mcp.invalid_token");
  });

  it("fences revoke to the owner/session and makes revoked grants permanently invalid", async () => {
    const issued = await mint();
    const identity = await grants.authenticateKey(issued.key ?? "");
    await expect(
      grants.revoke({ ...actor, ownerId: await env.createUser() }, issued.id),
    ).rejects.toThrow("mcp.not_found");
    expect(await grants.revoke(actor, issued.id)).toEqual({ id: issued.id, revoked: true });
    await expect(grants.require(identity, "tasks:read", [])).rejects.toThrow("mcp.forbidden");
    await expect(grants.authenticateKey(issued.key ?? "")).rejects.toThrow("mcp.invalid_token");
    await grants.revoke(actor, issued.id);
    expect(
      await env.db.first(
        sql("SELECT generation FROM mcp_grants WHERE id = :id", { id: issued.id }),
      ),
    ).toEqual({ generation: 2 });
  });

  it("does not mint or replay credentials after logout", async () => {
    const request = uuidv7();
    await grants.createKey(
      actor,
      { name: "One", scopes: ["tasks:read"], taskIds: null },
      fold(request),
    );
    await env.db.run(
      sql("UPDATE auth_sessions SET revoked_at = :now WHERE id = :session", {
        now: int(env.clock),
        session: actor.sessionId,
      }),
    );
    await expect(
      grants.createKey(
        actor,
        { name: "One", scopes: ["tasks:read"], taskIds: null },
        fold(request),
      ),
    ).rejects.toThrow("mcp.not_found");
    expect(await env.count("mcp_grants")).toBe(1);
    await expect(grants.list(actor)).rejects.toThrow("mcp.not_found");
  });

  it("rejects a relock between preparing and committing key creation", async () => {
    const original = env.db.batch.bind(env.db);
    vi.spyOn(env.db, "batch").mockImplementationOnce(async (statements) => {
      await env.db.run(
        sql("UPDATE users SET beta_state = 'relocked' WHERE id = :owner", { owner: actor.ownerId }),
      );
      return original(statements);
    });
    await expect(mint()).rejects.toThrow("mcp.not_found");
    expect(await env.count("mcp_grants")).toBe(0);
  });

  it("restriction revokes grants in its deciding batch so restore cannot revive old authority", async () => {
    const issued = await mint();
    const writeId = uuidv7();
    await env.db.batch([
      sql("UPDATE users SET beta_state = 'relocked', write_id = :write WHERE id = :owner", {
        owner: actor.ownerId,
        write: writeId,
      }),
      ...mcpRestrictContributor.statements({
        userId: actor.ownerId,
        writeId,
        now: env.clock,
        reason: "relocked",
      }),
    ]);
    await env.db.run(
      sql("UPDATE users SET beta_state = 'unlocked' WHERE id = :owner", { owner: actor.ownerId }),
    );
    await expect(grants.authenticateKey(issued.key ?? "")).rejects.toThrow("mcp.invalid_token");
    expect(
      await env.db.first(
        sql("SELECT revoked_at,generation FROM mcp_grants WHERE id = :id", { id: issued.id }),
      ),
    ).toEqual({ revoked_at: env.clock, generation: 2 });
  });
});
