import { randomBytes } from "node:crypto";
import {
  type McpCreateKey,
  type McpGrantView,
  type McpScope,
  mcpCreateKeySchema,
  mcpGrantViewSchema,
  mcpScopesSchema,
  mcpTaskScopeSchema,
} from "@symplist/contracts";
import {
  computeDigest,
  decryptFieldText,
  encryptFieldText,
  verifyDigest,
  zeroize,
} from "@symplist/crypto";
import { type DbRow, int, sql, uuidv7 } from "@symplist/db";
import { evaluateAccess } from "../access/evaluate.ts";
import { accessCondition, accessStateFromRow, accessStateSelectList } from "../access/sql.ts";
import { AccountKeyStore } from "../account/keys.ts";
import { type ConnectionWriteFold, connectionFoldCompletion } from "../connections/fold.ts";
import { McpError, type McpIdentity, type McpOptions, mcpField } from "./types.ts";

export interface McpOwner {
  readonly ownerId: string;
  readonly sessionId: string;
}
export type McpWriteFold = ConnectionWriteFold;
export const MCP_GRANT_LIFETIME_MS = 30 * 86400_000;

export function grantFromRow(row: DbRow): McpIdentity {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    kind: row.kind === "oauth" ? "oauth" : "api_key",
    clientId: row.client_id === null ? null : String(row.client_id),
    scopes: mcpScopesSchema.parse(JSON.parse(String(row.scopes))),
    taskIds:
      row.task_ids === null ? null : mcpTaskScopeSchema.parse(JSON.parse(String(row.task_ids))),
    generation: Number(row.generation),
    expiresAt: Number(row.expires_at),
  };
}

/** Trusted predicates for the actual core decision, never predicates accepted from MCP arguments. */
export function mcpAuthorization(
  identity: McpIdentity,
  scope: McpScope,
  now: number,
  taskIds: readonly string[] | null,
  prefix: "task_auth_" | "simon_auth_" | "mcp_auth_" = "mcp_auth_",
) {
  const p = (name: string) => `:${prefix}${name}`;
  return {
    sql: `EXISTS (SELECT 1 FROM mcp_grants g WHERE g.id = ${p("grant")} AND g.owner_id = ${p("user")} AND g.generation = ${p("generation")}
      AND g.revoked_at IS NULL AND g.expires_at > ${p("now")}
      AND EXISTS (SELECT 1 FROM json_each(g.scopes) s WHERE s.value = ${p("scope")} ${scope === "tasks:read" ? "OR s.value = 'tasks:write'" : ""})
      ${taskIds === null ? "AND g.task_ids IS NULL" : `AND (g.task_ids IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(${p("tasks")}) t WHERE NOT EXISTS (SELECT 1 FROM json_each(g.task_ids) allowed WHERE allowed.value = t.value)))`})`,
    params: {
      [`${prefix}grant`]: identity.id,
      [`${prefix}user`]: identity.ownerId,
      [`${prefix}generation`]: int(identity.generation),
      [`${prefix}now`]: int(now),
      [`${prefix}scope`]: scope,
      ...(taskIds === null ? {} : { [`${prefix}tasks`]: JSON.stringify(taskIds) }),
    },
  };
}

export class McpGrants {
  readonly accountKeys: AccountKeyStore;
  private readonly unknown = new Map<string, number>();
  constructor(readonly options: McpOptions) {
    this.accountKeys = new AccountKeyStore(options);
  }

  access(): string {
    return accessCondition({ level: "admitted", policy: this.options.policy, userParam: "owner" });
  }
  session(): string {
    return "EXISTS (SELECT 1 FROM auth_sessions WHERE id = :session AND user_id = :owner AND revoked_at IS NULL AND expires_at > :now)";
  }

  async list(actor: McpOwner): Promise<McpGrantView[]> {
    const result = await this.options.db.batch([
      sql(
        `SELECT * FROM mcp_grants WHERE owner_id = :owner AND ${this.access()} AND ${this.session()} ORDER BY (revoked_at IS NULL AND expires_at > :now) DESC, created_at DESC LIMIT 500`,
        { owner: actor.ownerId, session: actor.sessionId, now: int(this.options.now()) },
      ),
      this.accountKeys.selectStatement(actor.ownerId),
      sql(`SELECT 1 WHERE ${this.access()} AND ${this.session()}`, {
        owner: actor.ownerId,
        session: actor.sessionId,
        now: int(this.options.now()),
      }),
    ]);
    if (!result[2]?.results[0] || !result[1]?.results[0]) throw new McpError("mcp.not_found");
    const key = this.accountKeys.unwrapRow(result[1].results[0]);
    try {
      return (result[0]?.results ?? []).map((row) =>
        mcpGrantViewSchema.parse({
          id: row.id,
          kind: row.kind,
          name: decryptFieldText(
            key,
            mcpField(actor.ownerId, "mcp_grants", String(row.id), "client_name_enc"),
            String(row.client_name_enc),
          ),
          scopes: JSON.parse(String(row.scopes)),
          taskIds: row.task_ids === null ? null : JSON.parse(String(row.task_ids)),
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
        }),
      );
    } finally {
      zeroize(key.key);
    }
  }

  async createKey(
    actor: McpOwner,
    input: McpCreateKey,
    fold?: McpWriteFold,
  ): Promise<{ id: string; key?: string; expiresAt: number; secretUnavailable: boolean }> {
    const parsed = mcpCreateKeySchema.safeParse(input);
    if (!parsed.success) throw new McpError("mcp.invalid_request");
    if (fold && fold.claim.userId !== actor.ownerId) throw new McpError("mcp.not_found");
    const { db, keys, now } = this.options;
    const key = await this.accountKeys.require(actor.ownerId);
    const id = uuidv7(now());
    const token = `sym_${id}_${randomBytes(32).toString("base64url")}`;
    const digest = computeDigest(keys, "MCP_TOKEN_DIGEST_SECRET", "mcp-key", token);
    const expiresAt = now() + MCP_GRANT_LIFETIME_MS;
    const response = { id, key: token, expiresAt, secretUnavailable: false };
    const write = uuidv7(now());
    const inputTasks = JSON.stringify(parsed.data.taskIds ?? []);
    try {
      const result = await db.batch([
        ...(fold?.statements ?? []),
        sql(
          `INSERT INTO mcp_grants (id,owner_id,kind,client_name_enc,key_digest,digest_version,scopes,task_ids,created_at,expires_at,write_id)
          SELECT :id,:owner,'api_key',:name,:digest,:version,:scopes,${parsed.data.taskIds === null ? "NULL" : ":tasks"},:now,:expiry,:write
          WHERE ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
          AND (SELECT COUNT(*) FROM mcp_grants WHERE owner_id = :owner AND revoked_at IS NULL AND expires_at > :now) < 100
          AND NOT EXISTS (SELECT 1 FROM json_each(:selected) selected WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE id = selected.value AND owner_id = :owner AND status = 'active'))
          ${fold ? `AND ${fold.claim.guard.exists}` : ""}`,
          {
            id,
            owner: actor.ownerId,
            session: actor.sessionId,
            name: encryptFieldText(
              key,
              mcpField(actor.ownerId, "mcp_grants", id, "client_name_enc"),
              parsed.data.name,
            ),
            digest: digest.digest,
            version: int(digest.version),
            scopes: JSON.stringify(parsed.data.scopes),
            ...(parsed.data.taskIds === null ? {} : { tasks: inputTasks }),
            selected: inputTasks,
            now: int(now()),
            expiry: int(expiresAt),
            write,
            ...fold?.claim.guard.params,
          },
        ),
        ...(fold
          ? connectionFoldCompletion(
              fold,
              {
                status: 201,
                body: { id, key: "", expiresAt, secretUnavailable: false },
              },
              key,
              sql(
                "EXISTS (SELECT 1 FROM mcp_grants WHERE id = :grant AND write_id = :grant_write)",
                { grant: id, grant_write: write },
              ),
            )
          : []),
        sql(
          `SELECT 1 WHERE ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
          { owner: actor.ownerId, session: actor.sessionId, now: int(now()) },
        ),
        sql("SELECT id FROM mcp_grants WHERE id = :id AND write_id = :write", { id, write }),
      ]);
      if (!result.at(-2)?.results[0]) throw new McpError("mcp.not_found");
      const decision = fold?.decide(result, key);
      if (decision?.kind === "replay") return decision.body as typeof response;
      if (!result.at(-1)?.results[0]) throw new McpError("mcp.conflict");
      return response;
    } finally {
      zeroize(key.key);
    }
  }

  async authenticateKey(token: string): Promise<McpIdentity> {
    const match =
      /^sym_([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/.exec(
        token,
      );
    const id = match?.[1];
    if (!id || (this.unknown.get(id) ?? 0) > this.options.now())
      throw new McpError("mcp.invalid_token");
    const row = await this.options.db.first(
      sql(
        `SELECT g.*, ${accessStateSelectList("u", "access_")} FROM mcp_grants g JOIN users u ON u.id = g.owner_id WHERE g.id = :id AND g.kind = 'api_key' AND g.revoked_at IS NULL AND g.expires_at > :now`,
        { id, now: int(this.options.now()) },
      ),
    );
    if (!row) {
      if (this.unknown.size >= 4096) this.unknown.clear();
      this.unknown.set(id, this.options.now() + 60_000);
      throw new McpError("mcp.invalid_token");
    }
    if (
      !evaluateAccess(accessStateFromRow(row, "access_"), "admitted", this.options.policy).allowed
    )
      throw new McpError("mcp.invalid_token");
    if (
      !verifyDigest(this.options.keys, "MCP_TOKEN_DIGEST_SECRET", "mcp-key", token, {
        version: Number(row.digest_version),
        digest: String(row.key_digest),
      })
    )
      throw new McpError("mcp.invalid_token");
    const identity = grantFromRow(row);
    await this.touch(identity, row);
    return identity;
  }

  private async touch(identity: McpIdentity, row: DbRow): Promise<void> {
    if (row.last_used_at === null || Number(row.last_used_at) <= this.options.now() - 600_000)
      await this.options.db.run(
        sql(
          `UPDATE mcp_grants SET last_used_at = :now, write_id = :write WHERE id = :id AND generation = :generation AND revoked_at IS NULL AND expires_at > :now AND (last_used_at IS NULL OR last_used_at <= :before)`,
          {
            now: int(this.options.now()),
            write: uuidv7(this.options.now()),
            id: identity.id,
            generation: int(identity.generation),
            before: int(this.options.now() - 600_000),
          },
        ),
      );
  }

  async require(
    identity: McpIdentity,
    scope: McpScope,
    taskIds: readonly string[] | null,
  ): Promise<void> {
    const guard = mcpAuthorization(identity, scope, this.options.now(), taskIds);
    const row = await this.options.db.first(
      sql(
        `SELECT 1 WHERE ${guard.sql} AND ${this.access()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
        { ...guard.params, owner: identity.ownerId },
      ),
    );
    if (!row) throw new McpError("mcp.forbidden");
  }

  async authenticateOAuth(expected: McpIdentity): Promise<McpIdentity> {
    const cacheKey = `oauth:${expected.id}`;
    if ((this.unknown.get(cacheKey) ?? 0) > this.options.now())
      throw new McpError("mcp.invalid_token");
    const row = await this.options.db.first(
      sql(
        `SELECT g.*, ${accessStateSelectList("u", "access_")} FROM mcp_grants g JOIN users u ON u.id = g.owner_id
      WHERE g.id = :id`,
        { id: expected.id },
      ),
    );
    if (!row) {
      if (this.unknown.size >= 4096) this.unknown.clear();
      this.unknown.set(cacheKey, this.options.now() + 60_000);
      throw new McpError("mcp.invalid_token");
    }
    if (
      row.kind !== "oauth" ||
      row.owner_id !== expected.ownerId ||
      row.client_id !== expected.clientId ||
      row.generation !== expected.generation ||
      row.revoked_at !== null ||
      Number(row.expires_at) <= this.options.now() ||
      !evaluateAccess(accessStateFromRow(row, "access_"), "admitted", this.options.policy).allowed
    )
      throw new McpError("mcp.invalid_token");
    const identity = grantFromRow(row);
    if (
      JSON.stringify([...identity.scopes].sort()) !== JSON.stringify([...expected.scopes].sort()) ||
      JSON.stringify(identity.taskIds === null ? null : [...identity.taskIds].sort()) !==
        JSON.stringify(expected.taskIds === null ? null : [...expected.taskIds].sort())
    )
      throw new McpError("mcp.invalid_token");
    await this.touch(identity, row);
    return identity;
  }

  async revoke(
    actor: McpOwner,
    grantId: string,
    fold?: McpWriteFold,
  ): Promise<{ id: string; revoked: true }> {
    if (fold && fold.claim.userId !== actor.ownerId) throw new McpError("mcp.not_found");
    const { db, now } = this.options;
    const key = await this.accountKeys.require(actor.ownerId);
    const write = uuidv7(now());
    const response = { id: grantId, revoked: true as const };
    try {
      const result = await db.batch([
        ...(fold?.statements ?? []),
        sql(
          `UPDATE mcp_grants SET revoked_at = COALESCE(revoked_at,:now), generation = generation + CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END, write_id = :write
          WHERE id = :id AND owner_id = :owner AND ${this.access()} AND ${this.session()}
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner) ${fold ? `AND ${fold.claim.guard.exists}` : ""}`,
          {
            now: int(now()),
            write,
            id: grantId,
            owner: actor.ownerId,
            session: actor.sessionId,
            ...fold?.claim.guard.params,
          },
        ),
        ...(fold
          ? connectionFoldCompletion(
              fold,
              { status: 200, body: response },
              key,
              sql(
                "EXISTS (SELECT 1 FROM mcp_grants WHERE id = :grant AND write_id = :grant_write)",
                { grant: grantId, grant_write: write },
              ),
            )
          : []),
        sql(
          `SELECT 1 WHERE ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
          { owner: actor.ownerId, session: actor.sessionId, now: int(now()) },
        ),
        sql("SELECT 1 FROM mcp_grants WHERE id = :id AND owner_id = :owner AND write_id = :write", {
          id: grantId,
          owner: actor.ownerId,
          write,
        }),
      ]);
      if (!result.at(-2)?.results[0]) throw new McpError("mcp.not_found");
      const decision = fold?.decide(result, key);
      if (decision?.kind === "replay") return decision.body as typeof response;
      if (!result.at(-1)?.results[0]) throw new McpError("mcp.not_found");
      return response;
    } finally {
      zeroize(key.key);
    }
  }
}
