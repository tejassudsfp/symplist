import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { computeDigest, type DigestPurpose, type KeyProvider } from "@symplist/crypto";
import { type DbRow, int, sql, uuidv7 } from "@symplist/db";
import { grantFromRow, type McpGrants } from "./grants.ts";
import { McpError, type McpIdentity } from "./types.ts";

function candidates(keys: KeyProvider, purpose: DigestPurpose, token: string) {
  return JSON.stringify(
    keys.all("MCP_TOKEN_DIGEST_SECRET").map((entry) =>
      computeDigest(
        {
          current: () => entry,
          get: (family, version) => keys.get(family, version),
          all: (family) => keys.all(family),
        },
        "MCP_TOKEN_DIGEST_SECRET",
        purpose,
        token,
      ),
    ),
  );
}

export interface CodeExchange {
  readonly scope?: string;
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly verifier: string;
  readonly resource: string;
}
export interface RefreshExchange {
  readonly scope?: string;
  readonly refreshToken: string;
  readonly clientId: string;
  readonly resource: string;
}

/** Opaque code/refresh secrets only leave the successful CAS; storage retains HMACs, never secrets. */
export class OAuthTokens {
  constructor(
    readonly grants: McpGrants,
    readonly issuer: string,
  ) {}

  private async find(token: string, kind: "code" | "refresh"): Promise<DbRow> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new McpError("mcp.invalid_token");
    const { db, keys } = this.grants.options;
    const code = kind === "code";
    const row = await db.first(
      sql(
        `SELECT t.*, g.client_id AS bound_client, ${code ? "r.redirect_uri, r.challenge, r.resource, r.scopes AS request_scopes" : "g.scopes AS request_scopes"}
      FROM ${code ? "oauth_codes" : "oauth_refresh_tokens"} t JOIN mcp_grants g ON g.id = t.grant_id
      ${code ? "JOIN oauth_requests r ON r.id = t.request_id" : ""}
      WHERE EXISTS (SELECT 1 FROM json_each(:digests) d WHERE json_extract(d.value,'$.version') = t.digest_version AND json_extract(d.value,'$.digest') = t.${code ? "code_digest" : "token_digest"})`,
        {
          digests: candidates(keys, code ? "oauth-code" : "oauth-refresh", token),
        },
      ),
    );
    if (!row) throw new McpError("mcp.invalid_token");
    return row;
  }

  async code(input: CodeExchange) {
    if (
      input.resource !== `${this.issuer}/mcp` ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)
    )
      throw new McpError("mcp.invalid_token");
    const row = await this.find(input.code, "code");
    const challenge = createHash("sha256").update(input.verifier).digest("base64url");
    if (
      row.bound_client !== input.clientId ||
      row.redirect_uri !== input.redirectUri ||
      row.resource !== input.resource ||
      typeof row.challenge !== "string" ||
      row.challenge.length !== challenge.length ||
      !timingSafeEqual(Buffer.from(row.challenge), Buffer.from(challenge))
    )
      throw new McpError("mcp.invalid_token");
    this.checkScope(row, input.scope);
    const offline = (JSON.parse(String(row.request_scopes)) as string[]).includes("offline_access");
    return this.consume(row, "code", input.clientId, offline);
  }

  async refresh(input: RefreshExchange) {
    if (input.resource !== `${this.issuer}/mcp`) throw new McpError("mcp.invalid_token");
    const row = await this.find(input.refreshToken, "refresh");
    if (row.bound_client !== input.clientId || row.client_id !== input.clientId)
      throw new McpError("mcp.invalid_token");
    this.checkScope(row, input.scope);
    return this.consume(row, "refresh", input.clientId, true);
  }

  private checkScope(row: DbRow, scope: string | undefined) {
    if (scope === undefined) return;
    const requested = scope.split(" ").filter((s) => s !== "offline_access");
    const stored = (JSON.parse(String(row.request_scopes)) as string[]).filter(
      (s) => s !== "offline_access",
    );
    if (
      requested.length !== stored.length ||
      new Set(requested).size !== requested.length ||
      requested.some((s) => !stored.includes(s))
    )
      throw new McpError("mcp.invalid_token");
  }

  private async consume(row: DbRow, kind: "code" | "refresh", client: string, offline: boolean) {
    const { db, keys, now } = this.grants.options;
    const table = kind === "code" ? "oauth_codes" : "oauth_refresh_tokens";
    const owner = String(row.owner_id);
    const grant = String(row.grant_id);
    const id = String(row.id);
    const write = uuidv7(now());
    const token = randomBytes(32).toString("base64url");
    const digest = computeDigest(keys, "MCP_TOKEN_DIGEST_SECRET", "oauth-refresh", token);
    const active = `EXISTS (SELECT 1 FROM mcp_grants WHERE id = :grant AND owner_id = :owner AND client_id = :client AND kind = 'oauth' AND revoked_at IS NULL AND expires_at > :now) AND ${this.grants.access()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`;
    const params = { owner, grant, id, client, now: int(now()), write };
    const results = await db.batch([
      // Bindings and PKCE have already been verified. A true replay revokes even after code expiry.
      sql(
        `UPDATE mcp_grants SET revoked_at = :now, generation = generation + 1, write_id = :write WHERE id = :grant AND owner_id = :owner AND client_id = :client AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM ${table} WHERE id = :id AND consumed_at IS NOT NULL)`,
        params,
      ),
      sql(
        `UPDATE ${table} SET consumed_at = :now, write_id = :write WHERE id = :id AND owner_id = :owner AND grant_id = :grant AND consumed_at IS NULL AND expires_at > :now AND ${active}`,
        params,
      ),
      ...(offline
        ? [
            sql(
              `INSERT INTO oauth_refresh_tokens (id,owner_id,grant_id,client_id,token_digest,digest_version,created_at,expires_at,write_id)
        SELECT :next,:owner,:grant,:client,:digest,:version,:now,g.expires_at,:write FROM mcp_grants g WHERE g.id = :grant AND ${active}
        AND EXISTS (SELECT 1 FROM ${table} WHERE id = :id AND consumed_at = :now AND write_id = :write)`,
              {
                ...params,
                next: uuidv7(now()),
                digest: digest.digest,
                version: int(digest.version),
              },
            ),
          ]
        : []),
      sql(
        `SELECT g.* FROM mcp_grants g WHERE g.id = :grant AND ${active} AND EXISTS (SELECT 1 FROM ${table} WHERE id = :id AND consumed_at = :now AND write_id = :write)`,
        params,
      ),
    ]);
    const current = results.at(-1)?.results[0];
    if (!current) throw new McpError("mcp.invalid_token");
    return { identity: grantFromRow(current), ...(offline ? { refreshToken: token } : {}) };
  }

  /** Unknown tokens are indistinguishable from already revoked tokens (RFC 7009). */
  async revokeGrant(identity: McpIdentity, clientId: string): Promise<void> {
    if (identity.kind !== "oauth" || identity.clientId !== clientId) return;
    await this.grants.options.db.run(
      sql(
        `UPDATE mcp_grants SET revoked_at = :now, generation = generation + 1, write_id = :write WHERE id = :grant AND owner_id = :owner AND client_id = :client AND kind = 'oauth' AND generation = :generation AND revoked_at IS NULL`,
        {
          now: int(this.grants.options.now()),
          write: uuidv7(this.grants.options.now()),
          grant: identity.id,
          owner: identity.ownerId,
          client: clientId,
          generation: int(identity.generation),
        },
      ),
    );
  }

  async revoke(token: string, clientId: string): Promise<void> {
    let row: DbRow;
    try {
      row = await this.find(token, "refresh");
    } catch (error) {
      if (error instanceof McpError) return;
      throw error;
    }
    if (row.bound_client !== clientId || row.client_id !== clientId) return;
    await this.grants.options.db.run(
      sql(
        `UPDATE mcp_grants SET revoked_at = :now, generation = generation + 1, write_id = :write WHERE id = :grant AND client_id = :client AND kind = 'oauth' AND revoked_at IS NULL`,
        {
          now: int(this.grants.options.now()),
          write: uuidv7(this.grants.options.now()),
          grant: String(row.grant_id),
          client: clientId,
        },
      ),
    );
  }
}
