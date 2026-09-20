import { type AuthInfo, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { idSchema, mcpScopesSchema, mcpTaskScopeSchema } from "@symplist/contracts";
import type { McpGrants, McpIdentity } from "@symplist/core/mcp";
import type { KeyProvider } from "@symplist/crypto";
import { uuidv7 } from "@symplist/db";
import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { z } from "zod";

const claims = z.object({
  sub: idSchema,
  client_id: z.string().min(1).max(2048),
  grant_id: idSchema,
  gen: z.number().int().positive(),
  scope: z.string().min(1).max(128),
  task_scope: mcpTaskScopeSchema.optional(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: idSchema,
});

/** Resource-server verification is explicit: the MCP SDK itself does not check JWT audience. */
export class McpTokens {
  constructor(
    readonly options: {
      keys: KeyProvider;
      grants: Pick<McpGrants, "authenticateKey" | "authenticateOAuth">;
      issuer: string;
      now: () => number;
    },
  ) {}

  async sign(identity: McpIdentity): Promise<string> {
    if (identity.kind !== "oauth" || !identity.clientId) throw new Error("mcp.invalid_token");
    const key = this.options.keys.current("MCP_OAUTH_SIGNING_KEY");
    const now = Math.floor(this.options.now() / 1000);
    return new SignJWT({
      client_id: identity.clientId,
      grant_id: identity.id,
      gen: identity.generation,
      scope: identity.scopes.join(" "),
      ...(identity.taskIds === null ? {} : { task_scope: identity.taskIds }),
    })
      .setProtectedHeader({ typ: "at+jwt", alg: "HS256", kid: String(key.version) })
      .setIssuer(this.options.issuer)
      .setAudience(`${this.options.issuer}/mcp`)
      .setSubject(identity.ownerId)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .setJti(uuidv7(this.options.now()))
      .sign(key.key);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      if (typeof token !== "string" || token.length > 16384) throw new Error("invalid");
      if (token.startsWith("sym_")) {
        const identity = await this.options.grants.authenticateKey(token);
        return {
          token,
          clientId: `api_key:${identity.id}`,
          scopes: [...identity.scopes],
          expiresAt: Math.floor(this.options.now() / 1000) + 60,
          resource: new URL(`${this.options.issuer}/mcp`),
          extra: { identity },
        };
      }
      const header = decodeProtectedHeader(token);
      if (
        header.alg !== "HS256" ||
        header.typ !== "at+jwt" ||
        typeof header.kid !== "string" ||
        !/^[1-9][0-9]{0,8}$/.test(header.kid)
      )
        throw new Error("invalid");
      const key = this.options.keys.get("MCP_OAUTH_SIGNING_KEY", Number(header.kid));
      if (!key) throw new Error("invalid");
      const { payload } = await jwtVerify(token, key.key, {
        algorithms: ["HS256"],
        typ: "at+jwt",
        issuer: this.options.issuer,
        audience: `${this.options.issuer}/mcp`,
        currentDate: new Date(this.options.now()),
      });
      const parsed = claims.parse(payload);
      if (payload.aud !== `${this.options.issuer}/mcp`) throw new Error("invalid");
      if (parsed.exp - parsed.iat !== 900 || parsed.iat > Math.floor(this.options.now() / 1000))
        throw new Error("invalid");
      const identity = await this.options.grants.authenticateOAuth({
        id: parsed.grant_id,
        ownerId: parsed.sub,
        kind: "oauth",
        clientId: parsed.client_id,
        scopes: mcpScopesSchema.parse(parsed.scope.split(" ")),
        taskIds: parsed.task_scope ?? null,
        generation: parsed.gen,
        expiresAt: parsed.exp * 1000,
      });
      return {
        token,
        clientId: parsed.client_id,
        scopes: [...identity.scopes],
        expiresAt: parsed.exp,
        resource: new URL(`${this.options.issuer}/mcp`),
        extra: { identity },
      };
    } catch {
      // SDK turns every other exception into a 500; no crypto/provider error or token reaches logs.
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token");
    }
  }
}
