import { randomBytes } from "node:crypto";
import {
  computeDigest,
  computeDigestCandidates,
  decryptFieldText,
  encryptFieldText,
  type KeyProvider,
  zeroize,
} from "@symplist/crypto";
import { type DbClient, type DbRow, int, sql, uuidv7 } from "@symplist/db";
import {
  type ConnectionLifecycleProvider,
  IntegrationError,
  type ToolkitCatalogue,
} from "@symplist/integrations";
import type { AccessPolicy } from "../access/evaluate.ts";
import { accessCondition } from "../access/sql.ts";
import { AccountKeyStore } from "../account/keys.ts";
import { ComposioAuthConfigs } from "./auth-configs.ts";
import type { ComposioSessions } from "./sessions.ts";

export interface ConnectionActor {
  readonly ownerId: string;
  readonly sessionId: string;
}
export interface ConnectionView {
  readonly id: string;
  readonly toolkit: string;
  readonly alias: string | null;
  readonly status: "active" | "needs_attention" | "disconnected";
  readonly createdAt: number;
}

export function connectionAliasContext(
  ownerId: string,
  rowId: string,
  table: "connections" | "connection_attempts",
) {
  return { ownerId, table, rowId, column: "alias_enc", purpose: "connection_alias" };
}

function nonceValue(attempt: string, value: string): string {
  return `connection-attempt\0${attempt}\0${value}`;
}

export interface ConnectionsOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
  readonly apiOrigin: string;
  readonly provider: ConnectionLifecycleProvider;
  readonly catalogue: Pick<ToolkitCatalogue, "list">;
  readonly sessions: Pick<ComposioSessions, "use">;
  readonly delay?: (ms: number) => Promise<void>;
}

/** Explicit callback attestation is the only path from a provider account into native authority. */
export class ConnectionsService {
  readonly accountKeys: AccountKeyStore;
  readonly configs: ComposioAuthConfigs;
  constructor(readonly options: ConnectionsOptions) {
    this.accountKeys = new AccountKeyStore(options);
    this.configs = new ComposioAuthConfigs(options.db, options.provider, options.now);
  }

  private access(): string {
    return accessCondition({ level: "admitted", policy: this.options.policy, userParam: "owner" });
  }
  private session(): string {
    return `EXISTS (SELECT 1 FROM auth_sessions WHERE id = :session AND user_id = :owner AND revoked_at IS NULL AND expires_at > :now)`;
  }

  private async actorRows(actor: ConnectionActor) {
    const result = await this.options.db.batch([
      sql(
        `SELECT owner_id, kek_version, wrapped_key FROM account_keys WHERE owner_id = :owner AND ${this.access()} AND ${this.session()}`,
        { owner: actor.ownerId, session: actor.sessionId, now: int(this.options.now()) },
      ),
      sql(
        `SELECT * FROM connections WHERE owner_id = :owner AND ${this.access()} AND ${this.session()} ORDER BY created_at, id LIMIT 501`,
        { owner: actor.ownerId, session: actor.sessionId, now: int(this.options.now()) },
      ),
    ]);
    const keyRow = result[0]?.results[0];
    if (!keyRow) throw new IntegrationError("integration.unauthorized");
    const rows = result[1]?.results ?? [];
    if (rows.length > 500) throw new IntegrationError("integration.unavailable");
    return { keyRow, rows };
  }

  async list(actor: ConnectionActor): Promise<readonly ConnectionView[]> {
    const { keyRow, rows } = await this.actorRows(actor);
    const key = this.accountKeys.unwrapRow(keyRow);
    try {
      return rows.map((row) => ({
        id: String(row.id),
        toolkit: String(row.toolkit),
        alias: row.alias_enc
          ? decryptFieldText(
              key,
              connectionAliasContext(actor.ownerId, String(row.id), "connections"),
              String(row.alias_enc),
            )
          : null,
        status: row.status as ConnectionView["status"],
        createdAt: Number(row.created_at),
      }));
    } finally {
      zeroize(key.key);
    }
  }

  async start(
    actor: ConnectionActor,
    input: { toolkit: string; alias?: string },
  ): Promise<{ attemptId: string; url: string; expiresAt: number }> {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(input.toolkit) ||
      (input.alias !== undefined && (!input.alias.trim() || input.alias.length > 120))
    )
      throw new IntegrationError("integration.invalid_arguments");
    const { keyRow, rows } = await this.actorRows(actor);
    if (rows.length >= 500) throw new IntegrationError("integration.unavailable");
    const toolkit = (await this.options.catalogue.list()).find(
      (item) => item.slug === input.toolkit,
    );
    if (!toolkit) throw new IntegrationError("integration.tool_unavailable");
    const config = await this.configs.findOrCreate(toolkit);
    const time = this.options.now();
    const id = uuidv7(time);
    const nonce = randomBytes(32).toString("base64url");
    const digest = computeDigest(
      this.options.keys,
      "SESSION_DIGEST_SECRET",
      "csrf",
      nonceValue(id, nonce),
    );
    const key = this.accountKeys.unwrapRow(keyRow);
    let alias: string | null;
    try {
      alias = input.alias
        ? encryptFieldText(
            key,
            connectionAliasContext(actor.ownerId, id, "connection_attempts"),
            input.alias.trim(),
          )
        : null;
    } finally {
      zeroize(key.key);
    }
    const created = await this.options.db.batch([
      sql(
        `INSERT INTO connection_attempts (id, user_id, auth_session_id, toolkit, alias_enc, nonce_digest, expires_at, status, created_at, updated_at, write_id)
        SELECT :id, :owner, :session, :toolkit, ${alias === null ? "NULL" : ":alias"}, :digest, :expiry, 'starting', :now, :now, :id
        WHERE ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
        AND (SELECT COUNT(*) FROM connection_attempts WHERE user_id = :owner AND status IN ('starting', 'pending', 'completing') AND expires_at > :now) < 5`,
        {
          id,
          owner: actor.ownerId,
          session: actor.sessionId,
          toolkit: toolkit.slug,
          ...(alias === null ? {} : { alias }),
          digest: `${digest.version}.${digest.digest}`,
          expiry: int(time + 600_000),
          now: int(time),
        },
      ),
      sql(`SELECT id FROM connection_attempts WHERE id = :id AND write_id = :id`, { id }),
    ]);
    if (!created[1]?.results[0]) throw new IntegrationError("integration.unavailable");
    let account: string | undefined;
    try {
      const callback = new URL("/v1/connections/callback", this.options.apiOrigin);
      callback.searchParams.set("attempt", id);
      callback.searchParams.set("n", nonce);
      const link = await this.options.provider.link(
        actor.ownerId,
        config,
        callback.href,
        input.alias?.trim(),
      );
      account = link.id;
      const saved = await this.options.db.batch([
        sql(
          `UPDATE connection_attempts SET connected_account_id = :account, status = 'pending', updated_at = :now WHERE id = :id AND user_id = :owner AND auth_session_id = :session AND status = 'starting' AND expires_at > :now AND ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
          {
            account,
            now: int(this.options.now()),
            id,
            owner: actor.ownerId,
            session: actor.sessionId,
          },
        ),
        sql(
          `SELECT id FROM connection_attempts WHERE id = :id AND status = 'pending' AND connected_account_id = :account`,
          { id, account },
        ),
      ]);
      if (!saved[1]?.results[0]) throw new IntegrationError("integration.unauthorized");
      return { attemptId: id, url: link.url, expiresAt: time + 600_000 };
    } catch (error) {
      await this.options.db.run(
        sql(
          `UPDATE connection_attempts SET status = 'failed', updated_at = :now WHERE id = :id AND status IN ('starting', 'pending')`,
          { now: int(this.options.now()), id },
        ),
      );
      if (account) await this.options.provider.revoke(account).catch(() => undefined);
      throw error;
    }
  }

  async callback(
    actor: ConnectionActor,
    input: { attemptId: string; nonce: string; sessionUri: string },
  ): Promise<string> {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(input.nonce) ||
      !input.sessionUri ||
      input.sessionUri.length > 4096
    )
      throw new IntegrationError("integration.invalid_arguments");
    const now = this.options.now();
    const write = uuidv7(now);
    const digests = computeDigestCandidates(
      this.options.keys,
      "SESSION_DIGEST_SECRET",
      "csrf",
      nonceValue(input.attemptId, input.nonce),
    );
    const nonceParams = Object.fromEntries(
      digests.map((digest, index) => [`nonce_${index}`, `${digest.version}.${digest.digest}`]),
    );
    const result = await this.options.db.batch([
      sql(
        `UPDATE connection_attempts SET status = 'completing', updated_at = :now, write_id = :write
        WHERE id = :id AND nonce_digest IN (${Object.keys(nonceParams)
          .map((name) => `:${name}`)
          .join(", ")}) AND user_id = :owner AND auth_session_id = :session
        AND status = 'pending' AND expires_at > :now AND ${this.access()} AND ${this.session()}
        AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
        {
          now: int(now),
          write,
          id: input.attemptId,
          ...nonceParams,
          owner: actor.ownerId,
          session: actor.sessionId,
        },
      ),
      sql(
        `SELECT * FROM connection_attempts WHERE id = :id AND write_id = :write AND status = 'completing'`,
        { id: input.attemptId, write },
      ),
      this.accountKeys.selectStatement(actor.ownerId),
    ]);
    const attempt = result[1]?.results[0];
    const keyRow = result[2]?.results[0];
    if (!attempt || !keyRow) throw new IntegrationError("integration.unauthorized");
    try {
      await this.options.provider.complete(input.sessionUri, actor.ownerId);
      let active = false;
      for (let tries = 0; tries < 4; tries++) {
        const account = await this.options.provider.account(String(attempt.connected_account_id));
        if (account.id !== attempt.connected_account_id || account.toolkit !== attempt.toolkit)
          throw new IntegrationError("integration.invalid_response");
        if (account.status === "ACTIVE") {
          active = true;
          break;
        }
        if (!["INITIALIZING", "INITIATED"].includes(account.status)) break;
        if (tries < 3)
          await (
            this.options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
          )(250 * (tries + 1));
      }
      if (!active) throw new IntegrationError("integration.connection_required");
      const connection = await this.confirm(actor, attempt, keyRow, write);
      await this.options.sessions.use(actor.ownerId);
      return connection;
    } catch (error) {
      const failed = await this.options.db.batch([
        sql(
          `UPDATE connection_attempts SET status = 'failed', updated_at = :now WHERE id = :id AND write_id = :write AND status = 'completing'`,
          { now: int(this.options.now()), id: input.attemptId, write },
        ),
        sql(
          `SELECT connected_account_id FROM connection_attempts WHERE id = :id AND write_id = :write AND status = 'failed'`,
          { id: input.attemptId, write },
        ),
      ]);
      if (failed[1]?.results[0])
        await this.options.provider
          .revoke(String(attempt.connected_account_id))
          .catch(() => undefined);
      throw error;
    }
  }

  private async confirm(
    actor: ConnectionActor,
    attempt: DbRow,
    keyRow: DbRow,
    write: string,
  ): Promise<string> {
    const id = uuidv7(this.options.now());
    const key = this.accountKeys.unwrapRow(keyRow);
    let alias: string | null;
    try {
      alias = attempt.alias_enc
        ? encryptFieldText(
            key,
            connectionAliasContext(actor.ownerId, id, "connections"),
            decryptFieldText(
              key,
              connectionAliasContext(actor.ownerId, String(attempt.id), "connection_attempts"),
              String(attempt.alias_enc),
            ),
          )
        : null;
    } finally {
      zeroize(key.key);
    }
    const guard = `EXISTS (SELECT 1 FROM connection_attempts WHERE id = :attempt AND user_id = :owner AND auth_session_id = :session AND write_id = :write AND status = 'completing' AND expires_at > :now)`;
    const result = await this.options.db.batch([
      sql(
        `INSERT INTO connections (id, owner_id, toolkit, connected_account_id, alias_enc, status, confirmed_at, created_at, updated_at, write_id)
        SELECT :id, :owner, :toolkit, :account, ${alias === null ? "NULL" : ":alias"}, 'active', :now, :now, :now, :write
        WHERE ${guard} AND ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
        {
          id,
          owner: actor.ownerId,
          toolkit: String(attempt.toolkit),
          account: String(attempt.connected_account_id),
          ...(alias === null ? {} : { alias }),
          now: int(this.options.now()),
          write,
          attempt: String(attempt.id),
          session: actor.sessionId,
        },
      ),
      sql(
        `UPDATE connection_attempts SET status = 'confirmed', updated_at = :now WHERE id = :attempt AND write_id = :write AND EXISTS (SELECT 1 FROM connections WHERE id = :id AND write_id = :write)`,
        { now: int(this.options.now()), attempt: String(attempt.id), write, id },
      ),
      sql(`SELECT id FROM connections WHERE id = :id AND write_id = :write`, { id, write }),
    ]);
    if (!result[2]?.results[0]) throw new IntegrationError("integration.unauthorized");
    return id;
  }
}
