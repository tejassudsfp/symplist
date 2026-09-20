import { randomBytes } from "node:crypto";
import {
  mcpScopesSchema,
  type OAuthAuthorize,
  type OAuthConsentView,
  type OAuthDecision,
  oauthConsentViewSchema,
  oauthDecisionSchema,
} from "@symplist/contracts";
import { computeDigest, decryptFieldText, encryptFieldText, zeroize } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { connectionFoldCompletion } from "../connections/fold.ts";
import {
  MCP_GRANT_LIFETIME_MS,
  type McpGrants,
  type McpOwner,
  type McpWriteFold,
} from "./grants.ts";
import { McpError, mcpField } from "./types.ts";

/** Metadata already vetted by the API's registration/CIMD boundary. Never fetched by core. */
export interface ConsentClient {
  readonly name: string;
  readonly unverified: boolean;
  readonly metadataHost: string | null;
  readonly loopbackOnly: boolean;
}

export function oauthScopes(value: string) {
  const scopes = value.split(" ");
  if (new Set(scopes).size !== scopes.length) throw new McpError("mcp.invalid_request");
  const resourceScopes = mcpScopesSchema.safeParse(scopes.filter((s) => s !== "offline_access"));
  if (!resourceScopes.success) throw new McpError("mcp.invalid_request");
  return { scopes: resourceScopes.data, offlineAccess: scopes.includes("offline_access") };
}

export class OAuthRequests {
  constructor(
    readonly grants: McpGrants,
    readonly issuer: string,
  ) {}

  private authority(actor: McpOwner) {
    return {
      sql: `${this.grants.access()} AND ${this.grants.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
      params: {
        owner: actor.ownerId,
        session: actor.sessionId,
        now: int(this.grants.options.now()),
      },
    };
  }

  async create(actor: McpOwner, input: OAuthAuthorize, client: ConsentClient): Promise<string> {
    oauthScopes(input.scope);
    if (input.resource !== `${this.issuer}/mcp`) throw new McpError("mcp.invalid_request");
    const { db, now } = this.grants.options;
    const authority = this.authority(actor);
    const key = await this.grants.accountKeys.require(actor.ownerId);
    const id = uuidv7(now());
    try {
      const results = await db.batch([
        sql(
          `INSERT INTO oauth_requests (id,owner_id,auth_session_id,client_id,client_name_enc,redirect_uri,scopes,resource,challenge,state_enc,created_at,expires_at,write_id)
          SELECT :id,:owner,:session,:client,:name,:redirect,:scopes,:resource,:challenge,:state,:now,:expiry,:id
          WHERE ${authority.sql} AND (SELECT COUNT(*) FROM oauth_requests WHERE owner_id = :owner AND decided_at IS NULL AND expires_at > :now) < 20`,
          {
            ...authority.params,
            id,
            client: input.client_id,
            name: encryptFieldText(
              key,
              mcpField(actor.ownerId, "oauth_requests", id, "client_name_enc"),
              JSON.stringify(client),
            ),
            redirect: input.redirect_uri,
            scopes: JSON.stringify(input.scope.split(" ")),
            resource: input.resource,
            challenge: input.code_challenge,
            state:
              input.state === undefined
                ? null
                : encryptFieldText(
                    key,
                    mcpField(actor.ownerId, "oauth_requests", id, "state_enc"),
                    input.state,
                  ),
            expiry: int(now() + 600_000),
          },
        ),
        sql("SELECT id FROM oauth_requests WHERE id = :id", { id }),
      ]);
      if (!results[1]?.results[0]) throw new McpError("mcp.not_found");
      return id;
    } finally {
      zeroize(key.key);
    }
  }

  private async read(actor: McpOwner, id: string) {
    const authority = this.authority(actor);
    const results = await this.grants.options.db.batch([
      sql(
        `SELECT * FROM oauth_requests WHERE id = :id AND owner_id = :owner AND auth_session_id = :session AND expires_at > :now AND ${authority.sql}`,
        { ...authority.params, id },
      ),
      this.grants.accountKeys.selectStatement(actor.ownerId),
    ]);
    const row = results[0]?.results[0];
    const keyRow = results[1]?.results[0];
    if (!row || !keyRow) throw new McpError("mcp.not_found");
    return { row, key: this.grants.accountKeys.unwrapRow(keyRow) };
  }

  async view(actor: McpOwner, id: string): Promise<OAuthConsentView> {
    const { row, key } = await this.read(actor, id);
    try {
      if (row.decided_at !== null) throw new McpError("mcp.conflict");
      const client = JSON.parse(
        decryptFieldText(
          key,
          mcpField(actor.ownerId, "oauth_requests", id, "client_name_enc"),
          String(row.client_name_enc),
        ),
      ) as ConsentClient;
      const scope = oauthScopes((JSON.parse(String(row.scopes)) as string[]).join(" "));
      return oauthConsentViewSchema.parse({
        id,
        clientName: client.name,
        unverified: client.unverified,
        metadataHost: client.metadataHost,
        redirectHost: new URL(String(row.redirect_uri)).hostname,
        loopbackOnly: client.loopbackOnly,
        ...scope,
        expiresAt: row.expires_at,
      });
    } finally {
      zeroize(key.key);
    }
  }

  async decide(actor: McpOwner, id: string, decision: OAuthDecision, fold?: McpWriteFold) {
    const parsed = oauthDecisionSchema.safeParse(decision);
    if (!parsed.success || (fold && fold.claim.userId !== actor.ownerId))
      throw new McpError("mcp.invalid_request");
    const { row, key } = await this.read(actor, id);
    const { db, now, keys } = this.grants.options;
    const authority = this.authority(actor);
    const write = uuidv7(now());
    const grant = uuidv7(now());
    const allow = parsed.data.decision === "allow";
    const tasks = parsed.data.decision === "allow" ? parsed.data.taskIds : null;
    const code = randomBytes(32).toString("base64url");
    const digest = computeDigest(keys, "MCP_TOKEN_DIGEST_SECRET", "oauth-code", code);
    const applied = sql(
      "EXISTS (SELECT 1 FROM oauth_requests WHERE id = :oauth_request AND write_id = :oauth_write AND decided_at IS NOT NULL)",
      { oauth_request: id, oauth_write: write },
    );
    try {
      const client = JSON.parse(
        decryptFieldText(
          key,
          mcpField(actor.ownerId, "oauth_requests", id, "client_name_enc"),
          String(row.client_name_enc),
        ),
      ) as ConsentClient;
      const scopes = oauthScopes((JSON.parse(String(row.scopes)) as string[]).join(" ")).scopes;
      const redirect = new URL(String(row.redirect_uri));
      redirect.searchParams.set("iss", this.issuer);
      if (row.state_enc !== null)
        redirect.searchParams.set(
          "state",
          decryptFieldText(
            key,
            mcpField(actor.ownerId, "oauth_requests", id, "state_enc"),
            String(row.state_enc),
          ),
        );
      if (allow) redirect.searchParams.set("code", code);
      else redirect.searchParams.set("error", "access_denied");
      const response = { requestId: id, redirectUrl: redirect.href, secretUnavailable: false };
      const results = await db.batch([
        ...(fold?.statements ?? []),
        sql(
          `UPDATE oauth_requests SET decided_at = :now, write_id = :write WHERE id = :id AND owner_id = :owner AND auth_session_id = :session
          AND decided_at IS NULL AND expires_at > :now AND ${authority.sql}
          AND NOT EXISTS (SELECT 1 FROM json_each(:tasks) chosen WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE id = chosen.value AND owner_id = :owner AND status = 'active'))
          ${allow ? "AND (SELECT COUNT(*) FROM mcp_grants WHERE owner_id = :owner AND revoked_at IS NULL AND expires_at > :now) < 100" : ""}
          ${fold ? `AND ${fold.claim.guard.exists}` : ""}`,
          {
            ...authority.params,
            id,
            write,
            tasks: JSON.stringify(tasks ?? []),
            ...fold?.claim.guard.params,
          },
        ),
        ...(allow
          ? [
              sql(
                `INSERT INTO mcp_grants (id,owner_id,kind,client_id,client_name_enc,scopes,task_ids,created_at,expires_at,write_id)
            SELECT :grant,:owner,'oauth',:client,:name,:scopes,:tasks,:now,:expiry,:write WHERE EXISTS (SELECT 1 FROM oauth_requests WHERE id = :id AND write_id = :write)`,
                {
                  grant,
                  owner: actor.ownerId,
                  client: String(row.client_id),
                  name: encryptFieldText(
                    key,
                    mcpField(actor.ownerId, "mcp_grants", grant, "client_name_enc"),
                    client.name,
                  ),
                  scopes: JSON.stringify(scopes),
                  tasks: tasks === null ? null : JSON.stringify(tasks),
                  now: int(now()),
                  expiry: int(now() + MCP_GRANT_LIFETIME_MS),
                  write,
                  id,
                },
              ),
              sql(
                "UPDATE oauth_requests SET grant_id = :grant WHERE id = :id AND write_id = :write",
                { grant, id, write },
              ),
              sql(
                `INSERT INTO oauth_codes (id,owner_id,grant_id,request_id,code_digest,digest_version,created_at,expires_at,write_id)
            SELECT :code_id,:owner,:grant,:id,:digest,:version,:now,:expiry,:write WHERE EXISTS (SELECT 1 FROM oauth_requests WHERE id = :id AND write_id = :write)`,
                {
                  code_id: uuidv7(now()),
                  owner: actor.ownerId,
                  grant,
                  id,
                  digest: digest.digest,
                  version: int(digest.version),
                  now: int(now()),
                  expiry: int(now() + 60_000),
                  write,
                },
              ),
            ]
          : []),
        ...(fold
          ? connectionFoldCompletion(
              fold,
              { status: 200, body: { requestId: id, redirectUrl: "", secretUnavailable: false } },
              key,
              applied,
            )
          : []),
        sql(`SELECT 1 WHERE ${authority.sql}`, authority.params),
        { sql: `SELECT 1 WHERE ${applied.sql}`, params: applied.params },
      ]);
      if (!results.at(-2)?.results[0]) throw new McpError("mcp.not_found");
      const folded = fold?.decide(results, key);
      if (folded?.kind === "replay") return folded.body as typeof response;
      if (!results.at(-1)?.results[0]) throw new McpError("mcp.conflict");
      return response;
    } finally {
      zeroize(key.key);
    }
  }
}
