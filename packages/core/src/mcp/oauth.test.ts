import { createHash, randomBytes } from "node:crypto";
import type { OAuthAuthorize } from "@symplist/contracts";
import { createKeyProvider, type ManagedKeyProvider } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { IdempotencyStore, redactOneTimeSecretResponse } from "../idempotency/index.ts";
import { McpGrants, type McpOwner, type McpWriteFold } from "./grants.ts";
import { OAuthRequests, oauthScopes } from "./oauth-requests.ts";
import { OAuthTokens } from "./oauth-tokens.ts";

let env: DocumentsTestEnvironment;
let keys: ManagedKeyProvider;
let grants: McpGrants;
let requests: OAuthRequests;
let tokens: OAuthTokens;
let actor: McpOwner;
const issuer = "https://api.symplist.test";
const verifier = "A".repeat(43);
const client = {
  name: "private_client_marker",
  unverified: true,
  metadataHost: null,
  loopbackOnly: true,
};
const authorize: OAuthAuthorize = {
  response_type: "code",
  client_id: "public-client",
  redirect_uri: "http://127.0.0.1:49152/callback",
  resource: `${issuer}/mcp`,
  scope: "tasks:read offline_access",
  state: "private_oauth_state_marker",
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
};
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
  requests = new OAuthRequests(grants, issuer);
  tokens = new OAuthTokens(grants, issuer);
});
afterEach(async () => {
  vi.restoreAllMocks();
  keys.destroy();
  await env.close();
});

function fold(requestId: string, key: string): McpWriteFold {
  const store = new IdempotencyStore({ db: env.db, keys });
  const request = {
    scope: `POST /oauth/requests/${requestId}/decision`,
    userId: actor.ownerId,
    key,
    input: { decision: "allow", taskIds: null },
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
          body: redactOneTimeSecretResponse(response.body, ["redirectUrl"]),
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
async function issued(input: OAuthAuthorize = authorize, taskIds: string[] | null = null) {
  const id = await requests.create(actor, input, client);
  const decision = await requests.decide(actor, id, { decision: "allow", taskIds });
  const code = new URL(decision.redirectUrl).searchParams.get("code") ?? "";
  return {
    id,
    code,
    exchange: {
      code,
      clientId: input.client_id,
      redirectUri: input.redirect_uri,
      verifier,
      resource: input.resource,
    },
  };
}
async function dump() {
  const rows = await env.db.batch(
    [
      "oauth_requests",
      "oauth_codes",
      "oauth_refresh_tokens",
      "mcp_grants",
      "idempotency_records",
    ].map((table) => sql(`SELECT * FROM ${table}`)),
  );
  return JSON.stringify(rows);
}

describe("owner and session bound OAuth consent", () => {
  it("renders only exact session-bound consent and encrypts the client and state", async () => {
    const id = await requests.create(actor, authorize, client);
    expect(await requests.view(actor, id)).toEqual({
      id,
      clientName: client.name,
      unverified: true,
      metadataHost: null,
      redirectHost: "127.0.0.1",
      loopbackOnly: true,
      scopes: ["tasks:read"],
      offlineAccess: true,
      expiresAt: env.clock + 600_000,
    });
    await expect(requests.view({ ...actor, sessionId: uuidv7() }, id)).rejects.toThrow(
      "mcp.not_found",
    );
    await expect(requests.view({ ...actor, ownerId: await env.createUser() }, id)).rejects.toThrow(
      "mcp.not_found",
    );
    expect(await dump()).not.toContain(client.name);
    expect(await dump()).not.toContain(authorize.state);
  });
  it("returns a redirect once, persists no code/state/plain label, and redacts duplicate decisions", async () => {
    const id = await requests.create(actor, authorize, client);
    const key = uuidv7();
    const first = await requests.decide(
      actor,
      id,
      { decision: "allow", taskIds: null },
      fold(id, key),
    );
    const url = new URL(first.redirectUrl);
    expect(url.searchParams.get("iss")).toBe(issuer);
    expect(url.searchParams.get("state")).toBe(authorize.state);
    expect(url.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      await requests.decide(actor, id, { decision: "allow", taskIds: null }, fold(id, key)),
    ).toEqual({ requestId: id, secretUnavailable: true, notice: "secret.already_issued" });
    expect(await env.count("mcp_grants")).toBe(1);
    expect(await env.count("oauth_codes")).toBe(1);
    const stored = await dump();
    for (const secret of [
      first.redirectUrl,
      url.searchParams.get("code"),
      authorize.state,
      client.name,
    ])
      expect(stored).not.toContain(secret);
  });
  it("denies with state and issuer and never creates a grant or code", async () => {
    const id = await requests.create(actor, authorize, client);
    const result = await requests.decide(actor, id, { decision: "deny" });
    const url = new URL(result.redirectUrl);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("iss")).toBe(issuer);
    expect(url.searchParams.get("state")).toBe(authorize.state);
    expect(await env.count("mcp_grants")).toBe(0);
    await expect(requests.decide(actor, id, { decision: "allow", taskIds: null })).rejects.toThrow(
      "mcp.conflict",
    );
  });
  it("rejects expired, revoked-session and foreign-task decisions", async () => {
    const id = await requests.create(actor, authorize, client);
    await expect(
      requests.decide(actor, id, {
        decision: "allow",
        taskIds: [await env.createTask(await env.createUser())],
      }),
    ).rejects.toThrow("mcp.conflict");
    expect(await env.count("mcp_grants")).toBe(0);
    env.clock += 600_000;
    await expect(requests.decide(actor, id, { decision: "deny" })).rejects.toThrow("mcp.not_found");
    const pending = await requests.create(actor, authorize, client);
    await env.db.run(
      sql("UPDATE auth_sessions SET revoked_at = :now WHERE id = :id", {
        now: int(env.clock),
        id: actor.sessionId,
      }),
    );
    await expect(requests.decide(actor, pending, { decision: "deny" })).rejects.toThrow(
      "mcp.not_found",
    );
  });
  it("rechecks relock inside the deciding batch, including idempotency replay", async () => {
    const id = await requests.create(actor, authorize, client);
    const key = uuidv7();
    const batch = env.db.batch.bind(env.db);
    let injected = false;
    vi.spyOn(env.db, "batch").mockImplementation(async (statements) => {
      if (!injected && statements.some((s) => s.sql.startsWith("UPDATE oauth_requests"))) {
        injected = true;
        await env.relock(actor.ownerId);
      }
      return batch(statements);
    });
    await expect(
      requests.decide(actor, id, { decision: "allow", taskIds: null }, fold(id, key)),
    ).rejects.toThrow("mcp.not_found");
    expect(await env.count("mcp_grants")).toBe(0);
    expect(await env.count("idempotency_records")).toBe(0);
  });
  it("rejects duplicate, empty, unknown and offline-only scopes", () => {
    for (const scope of [
      "tasks:read tasks:read",
      "offline_access",
      "tasks:read  offline_access",
      "vault:read",
      "",
    ])
      expect(() => oauthScopes(scope)).toThrow("mcp.invalid_request");
  });
});

describe("OAuth single-use exchange, rotation and replay fencing", () => {
  it("issues only digest-stored refresh secrets and preserves selected task scope", async () => {
    const task = await env.createTask(actor.ownerId);
    const grant = await issued(authorize, [task]);
    const result = await tokens.code(grant.exchange);
    expect(result.identity).toMatchObject({
      ownerId: actor.ownerId,
      clientId: authorize.client_id,
      kind: "oauth",
      scopes: ["tasks:read"],
      taskIds: [task],
      expiresAt: env.clock + 30 * 86400_000,
    });
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await dump()).not.toContain(result.refreshToken);
    expect(await dump()).not.toContain(grant.code);
  });
  it("does not issue refresh without offline access", async () => {
    const grant = await issued({ ...authorize, scope: "tasks:read" });
    expect((await tokens.code(grant.exchange)).refreshToken).toBeUndefined();
    expect(await env.count("oauth_refresh_tokens")).toBe(0);
  });
  it.each(["clientId", "redirectUri", "verifier", "resource"] as const)(
    "rejects wrong %s without consuming or revoking a valid code",
    async (field) => {
      const grant = await issued();
      await expect(
        tokens.code({
          ...grant.exchange,
          [field]: field === "verifier" ? "B".repeat(43) : "wrong",
        }),
      ).rejects.toThrow("mcp.invalid_token");
      expect((await tokens.code(grant.exchange)).identity.generation).toBe(1);
    },
  );
  it("revokes a grant on code replay, even once the code has expired", async () => {
    const grant = await issued();
    const result = await tokens.code(grant.exchange);
    env.clock += 60_001;
    await expect(tokens.code(grant.exchange)).rejects.toThrow("mcp.invalid_token");
    await expect(grants.authenticateOAuth(result.identity)).rejects.toThrow("mcp.invalid_token");
    await expect(
      tokens.refresh({
        refreshToken: result.refreshToken ?? "",
        clientId: authorize.client_id,
        resource: authorize.resource,
      }),
    ).rejects.toThrow("mcp.invalid_token");
  });
  it("expires an unused code after exactly 60 seconds without minting tokens", async () => {
    const grant = await issued();
    env.clock += 60_000;
    await expect(tokens.code(grant.exchange)).rejects.toThrow("mcp.invalid_token");
    expect(await env.count("oauth_refresh_tokens")).toBe(0);
  });
  it("rotates refresh tokens and revokes the entire grant on reuse", async () => {
    const grant = await issued();
    const first = await tokens.code(grant.exchange);
    const request = {
      refreshToken: first.refreshToken ?? "",
      clientId: authorize.client_id,
      resource: authorize.resource,
    };
    const second = await tokens.refresh(request);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.identity.expiresAt).toBe(first.identity.expiresAt);
    expect(await dump()).not.toContain(second.refreshToken);
    await expect(tokens.refresh(request)).rejects.toThrow("mcp.invalid_token");
    await expect(
      tokens.refresh({ ...request, refreshToken: second.refreshToken ?? "" }),
    ).rejects.toThrow("mcp.invalid_token");
  });
  it("does not revoke a stolen refresh token submitted under a different client", async () => {
    const grant = await issued();
    const first = await tokens.code(grant.exchange);
    await expect(
      tokens.refresh({
        refreshToken: first.refreshToken ?? "",
        clientId: "other",
        resource: authorize.resource,
      }),
    ).rejects.toThrow("mcp.invalid_token");
    await tokens.revoke(first.refreshToken ?? "", "other");
    expect(await grants.authenticateOAuth(first.identity)).toEqual(first.identity);
    await tokens.revoke(first.refreshToken ?? "", authorize.client_id);
    await expect(grants.authenticateOAuth(first.identity)).rejects.toThrow("mcp.invalid_token");
    await tokens.revoke("unknown", authorize.client_id);
  });
  it("rechecks admission and grant revocation in the actual token write", async () => {
    const grant = await issued();
    const batch = env.db.batch.bind(env.db);
    vi.spyOn(env.db, "batch").mockImplementationOnce(async (statements) => {
      await env.relock(actor.ownerId);
      return batch(statements);
    });
    await expect(tokens.code(grant.exchange)).rejects.toThrow("mcp.invalid_token");
    expect(await env.count("oauth_refresh_tokens")).toBe(0);
  });
  it("does not extend the absolute grant lifetime when refreshing", async () => {
    const grant = await issued();
    const first = await tokens.code(grant.exchange);
    env.clock += 30 * 86400_000;
    await expect(
      tokens.refresh({
        refreshToken: first.refreshToken ?? "",
        clientId: authorize.client_id,
        resource: authorize.resource,
      }),
    ).rejects.toThrow("mcp.invalid_token");
  });
});
