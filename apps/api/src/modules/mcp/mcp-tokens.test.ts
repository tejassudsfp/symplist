import { randomBytes } from "node:crypto";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import type { McpIdentity } from "@symplist/core/mcp";
import { createKeyProvider, type ManagedKeyProvider } from "@symplist/crypto";
import { uuidv7 } from "@symplist/db";
import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpTokens } from "./mcp-tokens.ts";

let keys: ManagedKeyProvider;
let now: number;
let identity: McpIdentity;
let tokens: McpTokens;
const issuer = "https://api.example.test";
beforeEach(() => {
  now = Date.UTC(2026, 8, 16, 9);
  keys = createKeyProvider(
    {
      MCP_OAUTH_SIGNING_KEY: {
        current: 2,
        versions: new Map([
          [1, randomBytes(32)],
          [2, randomBytes(32)],
        ]),
      },
    },
    { required: ["MCP_OAUTH_SIGNING_KEY"] },
  );
  identity = {
    id: uuidv7(now),
    ownerId: uuidv7(now),
    kind: "oauth",
    clientId: "client",
    scopes: ["tasks:read"],
    taskIds: [uuidv7(now)],
    generation: 2,
    expiresAt: now + 30 * 86400_000,
  };
  tokens = new McpTokens({
    keys,
    issuer,
    now: () => now,
    grants: {
      authenticateKey: vi.fn(async () => ({
        ...identity,
        kind: "api_key" as const,
        clientId: null,
      })),
      authenticateOAuth: vi.fn(async (input) => ({ ...input, expiresAt: identity.expiresAt })),
    },
  });
});
afterEach(() => keys.destroy());

async function crafted(
  overrides: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const seconds = Math.floor(now / 1000);
  return new SignJWT({
    sub: identity.ownerId,
    client_id: identity.clientId,
    grant_id: identity.id,
    gen: identity.generation,
    scope: "tasks:read",
    task_scope: identity.taskIds,
    jti: uuidv7(now),
    iat: seconds,
    exp: seconds + 900,
    iss: issuer,
    aud: `${issuer}/mcp`,
    ...overrides,
  })
    .setProtectedHeader({ typ: "at+jwt", alg: "HS256", kid: "2", ...header })
    .sign(keys.current("MCP_OAUTH_SIGNING_KEY").key);
}

describe("MCP JWT and API-key verifier contract", () => {
  it("issues exact 15-minute HS256 access tokens with versioned key, issuer, audience and grant claims", async () => {
    const token = await tokens.sign(identity);
    expect(decodeProtectedHeader(token)).toEqual({ typ: "at+jwt", alg: "HS256", kid: "2" });
    const payload = decodeJwt(token);
    expect(payload).toMatchObject({
      iss: issuer,
      aud: `${issuer}/mcp`,
      sub: identity.ownerId,
      client_id: identity.clientId,
      grant_id: identity.id,
      gen: 2,
      task_scope: identity.taskIds,
      scope: "tasks:read",
      iat: now / 1000,
      exp: now / 1000 + 900,
    });
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    const result = await tokens.verifyAccessToken(token);
    expect(result).toMatchObject({
      token,
      clientId: "client",
      scopes: ["tasks:read"],
      expiresAt: now / 1000 + 900,
      extra: { identity },
    });
    expect(result.resource?.href).toBe(`${issuer}/mcp`);
  });

  it.each([
    { aud: "https://other.example/mcp" },
    { aud: [`${issuer}/mcp`, "https://other.example/mcp"] },
    { iss: "https://other.example" },
    { iss: `${issuer}/` },
    { gen: 0 },
    { sub: "other" },
    { scope: "tasks:read admin:all" },
    { scope: "tasks:read tasks:read" },
    { grant_id: "other" },
    { task_scope: [] },
    { client_id: "" },
    { jti: "other" },
  ])("rejects altered claims %j before grant lookup", async (altered) => {
    const token = await crafted(altered);
    await expect(tokens.verifyAccessToken(token)).rejects.toBeInstanceOf(OAuthError);
    await expect(tokens.verifyAccessToken(token)).rejects.toMatchObject({
      code: OAuthErrorCode.InvalidToken,
    });
    expect(tokens.options.grants.authenticateOAuth).not.toHaveBeenCalled();
  });

  it.each([{ typ: "JWT" }, { typ: "application/at+jwt" }, { kid: "02" }, { kid: "999" }])(
    "pins token header %j",
    async (header) => {
      await expect(tokens.verifyAccessToken(await crafted({}, header))).rejects.toMatchObject({
        code: OAuthErrorCode.InvalidToken,
      });
    },
  );

  it("rejects a wrong signing key, future issue time, non-15-minute duration and expiry", async () => {
    const valid = await tokens.sign(identity);
    const forged = await new SignJWT(decodeJwt(valid))
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt", kid: "2" })
      .sign(randomBytes(32));
    await expect(tokens.verifyAccessToken(forged)).rejects.toBeInstanceOf(OAuthError);
    await expect(
      tokens.verifyAccessToken(await crafted({ iat: now / 1000 + 1, exp: now / 1000 + 901 })),
    ).rejects.toBeInstanceOf(OAuthError);
    await expect(
      tokens.verifyAccessToken(await crafted({ exp: now / 1000 + 3600 })),
    ).rejects.toBeInstanceOf(OAuthError);
    now += 900_000;
    await expect(tokens.verifyAccessToken(valid)).rejects.toBeInstanceOf(OAuthError);
  });

  it("maps revoked/locked grant lookup failures to the SDK's sole invalid-token exception", async () => {
    const token = await tokens.sign(identity);
    tokens.options.grants.authenticateOAuth = vi.fn(async () => {
      throw new Error("private database marker");
    });
    await expect(tokens.verifyAccessToken(token)).rejects.toMatchObject({
      code: OAuthErrorCode.InvalidToken,
      message: "Invalid or expired access token",
    });
  });

  it("gives bearer keys a sixty-second synthetic expiry and performs no JWT interpretation", async () => {
    const result = await tokens.verifyAccessToken("sym_private_test_key");
    expect(result).toMatchObject({
      clientId: `api_key:${identity.id}`,
      expiresAt: now / 1000 + 60,
      scopes: ["tasks:read"],
      extra: { identity: { kind: "api_key" } },
    });
    expect(tokens.options.grants.authenticateOAuth).not.toHaveBeenCalled();
    expect(tokens.options.grants.authenticateKey).toHaveBeenCalledWith("sym_private_test_key");
  });
});
