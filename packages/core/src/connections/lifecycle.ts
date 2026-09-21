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
import { SimonRepository } from "../simon/repository.ts";
import { connectionApprovalExpiryStatements } from "./approval-expiry.ts";
import { ComposioAuthConfigs } from "./auth-configs.ts";
import { type ConnectionWriteFold, connectionFoldCompletion } from "./fold.ts";
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

export interface ConnectionStartResult {
  readonly attemptId: string;
  readonly expiresAt: number;
  readonly url?: string;
  readonly secretUnavailable?: boolean;
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
  readonly afterConfirmed?: (ownerId: string, connectionId: string) => Promise<void>;
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

/** A bound callback plus provider-confirmed account ownership is required for native authority. */
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
    input: { toolkit: string; alias?: string; replacesConnectionId?: string },
    fold?: ConnectionWriteFold,
  ): Promise<ConnectionStartResult> {
    if (fold && fold.claim.userId !== actor.ownerId)
      throw new IntegrationError("integration.unauthorized");
    if (
      !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(input.toolkit) ||
      (input.alias !== undefined && (!input.alias.trim() || input.alias.length > 120))
    )
      throw new IntegrationError("integration.invalid_arguments");
    const { keyRow, rows } = await this.actorRows(actor);
    const replaces = input.replacesConnectionId
      ? rows.find((row) => row.id === input.replacesConnectionId && row.toolkit === input.toolkit)
      : undefined;
    if (input.replacesConnectionId && !replaces)
      throw new IntegrationError("integration.unauthorized");
    if (!replaces && rows.length >= 500) throw new IntegrationError("integration.unavailable");
    const toolkit = (await this.options.catalogue.list()).find(
      (item) => item.slug === input.toolkit,
    );
    if (!toolkit) throw new IntegrationError("integration.tool_unavailable");
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
    let aliasText = input.alias?.trim();
    try {
      if (aliasText === undefined && replaces?.alias_enc)
        aliasText = decryptFieldText(
          key,
          connectionAliasContext(actor.ownerId, String(replaces.id), "connections"),
          String(replaces.alias_enc),
        );
      alias = aliasText
        ? encryptFieldText(
            key,
            connectionAliasContext(actor.ownerId, id, "connection_attempts"),
            aliasText,
          )
        : null;
    } finally {
      zeroize(key.key);
    }
    const foldKey = this.accountKeys.unwrapRow(keyRow);
    const planned: ConnectionStartResult = {
      attemptId: id,
      expiresAt: time + 600_000,
      url: "",
      secretUnavailable: false,
    };
    const applied = sql(
      `EXISTS (SELECT 1 FROM connection_attempts WHERE id = :id AND user_id = :owner AND write_id = :id) AND ${this.access()} AND ${this.session()}`,
      { id, owner: actor.ownerId, session: actor.sessionId, now: int(time) },
    );
    const statements = [
      ...(fold?.statements ?? []),
      sql(
        `INSERT INTO connection_attempts (id, user_id, auth_session_id, toolkit, alias_enc, nonce_digest, expires_at, status, created_at, updated_at, write_id, replaces_connection_id, replaces_generation)
        SELECT :id, :owner, :session, :toolkit, ${alias === null ? "NULL" : ":alias"}, :digest, :expiry, 'starting', :now, :now, :id, ${replaces ? ":replaces, :replaces_generation" : "NULL, NULL"}
        WHERE ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
        AND (SELECT COUNT(*) FROM connection_attempts WHERE user_id = :owner AND status IN ('starting', 'pending', 'completing') AND expires_at > :now) < 5
        ${fold ? `AND ${fold.claim.guard.exists}` : ""}`,
        {
          id,
          owner: actor.ownerId,
          session: actor.sessionId,
          toolkit: toolkit.slug,
          ...(alias === null ? {} : { alias }),
          digest: `${digest.version}.${digest.digest}`,
          expiry: int(time + 600_000),
          now: int(time),
          ...fold?.claim.guard.params,
          ...(replaces
            ? {
                replaces: String(replaces.id),
                replaces_generation: int(Number(replaces.generation)),
              }
            : {}),
        },
      ),
      sql(`SELECT id FROM connection_attempts WHERE id = :id AND write_id = :id`, { id }),
      ...(fold
        ? connectionFoldCompletion(fold, { status: 201, body: planned }, foldKey, applied)
        : []),
      sql(
        `SELECT 1 AS allowed WHERE ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
        { owner: actor.ownerId, session: actor.sessionId, now: int(this.options.now()) },
      ),
    ];
    try {
      const created = await this.options.db.batch(statements);
      if (!created.at(-1)?.results[0]) throw new IntegrationError("integration.unauthorized");
      const decision = fold?.decide(created, foldKey);
      if (decision?.kind === "replay") return decision.body as ConnectionStartResult;
      if (!created[(fold?.statements.length ?? 0) + 1]?.results[0])
        throw new IntegrationError("integration.unavailable");
    } finally {
      zeroize(foldKey.key);
    }
    let account: string | undefined;
    try {
      const config = await this.configs.findOrCreate(toolkit);
      const allowed = await this.options.db.first(
        sql(
          `SELECT 1 AS allowed FROM connection_attempts WHERE id = :id AND user_id = :owner AND auth_session_id = :session AND status = 'starting' AND expires_at > :now AND ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
          { id, owner: actor.ownerId, session: actor.sessionId, now: int(this.options.now()) },
        ),
      );
      if (!allowed) throw new IntegrationError("integration.unauthorized");
      const callback = new URL("/v1/connections/callback", this.options.apiOrigin);
      callback.searchParams.set("attempt", id);
      callback.searchParams.set("n", nonce);
      const link = await this.options.provider.link(
        actor.ownerId,
        config,
        callback.href,
        aliasText,
      );
      account = link.id;
      const linkWrite = uuidv7(this.options.now());
      const saved = await this.options.db.batch([
        sql(
          `UPDATE connection_attempts SET connected_account_id = :account, status = 'pending', updated_at = :now, write_id = :write WHERE id = :id AND user_id = :owner AND auth_session_id = :session AND status = 'starting' AND expires_at > :now AND ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
          {
            account,
            now: int(this.options.now()),
            id,
            owner: actor.ownerId,
            session: actor.sessionId,
            write: linkWrite,
          },
        ),
        sql(
          `SELECT id FROM connection_attempts WHERE id = :id AND status = 'pending' AND connected_account_id = :account AND write_id = :write`,
          { id, account, write: linkWrite },
        ),
      ]);
      if (!saved[1]?.results[0]) throw new IntegrationError("integration.unauthorized");
      return { attemptId: id, url: link.url, expiresAt: time + 600_000, secretUnavailable: false };
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
    input: { attemptId: string; nonce: string; sessionUri?: string; connectedAccountId?: string },
  ): Promise<string> {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(input.nonce) ||
      (!input.sessionUri && !input.connectedAccountId) ||
      (input.sessionUri !== undefined && input.sessionUri.length > 4096) ||
      (input.connectedAccountId !== undefined &&
        (input.connectedAccountId.length < 1 || input.connectedAccountId.length > 256))
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
        AND status = 'pending' ${input.connectedAccountId ? "AND connected_account_id = :callback_account" : ""}
        AND expires_at > :now AND ${this.access()} AND ${this.session()}
        AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
        {
          now: int(now),
          write,
          id: input.attemptId,
          ...(input.connectedAccountId ? { callback_account: input.connectedAccountId } : {}),
          ...nonceParams,
          owner: actor.ownerId,
          session: actor.sessionId,
        },
      ),
      sql(
        `SELECT a.*, c.connected_account_id AS replacing_account FROM connection_attempts a
        LEFT JOIN connections c ON c.id = a.replaces_connection_id AND c.owner_id = a.user_id AND c.generation = a.replaces_generation
        WHERE a.id = :id AND a.write_id = :write AND a.status = 'completing'`,
        { id: input.attemptId, write },
      ),
      this.accountKeys.selectStatement(actor.ownerId),
    ]);
    const attempt = result[1]?.results[0];
    const keyRow = result[2]?.results[0];
    if (!attempt || !keyRow) throw new IntegrationError("integration.unauthorized");
    try {
      if (input.sessionUri) await this.options.provider.complete(input.sessionUri, actor.ownerId);
      else await this.assertProviderOwner(actor.ownerId, String(attempt.connected_account_id));
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
      await this.options.afterConfirmed?.(actor.ownerId, connection);
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

  private async assertProviderOwner(ownerId: string, accountId: string): Promise<void> {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.options.provider.accounts(ownerId, cursor);
      if (result.items.some((item) => item.id === accountId)) return;
      cursor = result.cursor ?? undefined;
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    throw new IntegrationError("integration.unauthorized");
  }

  private async confirm(
    actor: ConnectionActor,
    attempt: DbRow,
    keyRow: DbRow,
    write: string,
  ): Promise<string> {
    const id = attempt.replaces_connection_id
      ? String(attempt.replaces_connection_id)
      : uuidv7(this.options.now());
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
      ...(attempt.replaces_connection_id
        ? [
            sql(
              `UPDATE connections SET connected_account_id = :account, alias_enc = ${alias === null ? "NULL" : ":alias"}, status = 'active', generation = generation + 1, confirmed_at = :now, updated_at = :now, write_id = :write
        WHERE id = :id AND owner_id = :owner AND toolkit = :toolkit AND generation = :generation
        AND ${guard} AND ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
              {
                account: String(attempt.connected_account_id),
                ...(alias === null ? {} : { alias }),
                now: int(this.options.now()),
                write,
                id,
                owner: actor.ownerId,
                toolkit: String(attempt.toolkit),
                generation: int(Number(attempt.replaces_generation)),
                attempt: String(attempt.id),
                session: actor.sessionId,
              },
            ),
            ...connectionApprovalExpiryStatements(
              new SimonRepository({ ...this.options, quickChatTtlHours: 24 }),
              { ownerId: actor.ownerId, connectionId: id, writeId: write, now: this.options.now() },
            ),
            sql(
              `INSERT INTO connection_revoke_jobs (connected_account_id, owner_id, created_at, write_id)
          SELECT :account, :owner, :now, :write WHERE EXISTS (SELECT 1 FROM connections WHERE id = :id AND owner_id = :owner AND write_id = :write)
          ON CONFLICT (connected_account_id) DO NOTHING`,
              {
                account: String(attempt.replacing_account),
                owner: actor.ownerId,
                now: int(this.options.now()),
                write,
                id,
              },
            ),
          ]
        : [
            sql(
              `INSERT INTO connections (id, owner_id, toolkit, connected_account_id, alias_enc, status, confirmed_at, created_at, updated_at, write_id)
        SELECT :id, :owner, :toolkit, :account, ${alias === null ? "NULL" : ":alias"}, 'active', :now, :now, :now, :write
        WHERE ${guard} AND ${this.access()} AND ${this.session()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
        AND (SELECT COUNT(*) FROM connections WHERE owner_id = :owner) < 500`,
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
          ]),
      sql(
        `UPDATE connection_attempts SET status = 'confirmed', updated_at = :now WHERE id = :attempt AND write_id = :write AND EXISTS (SELECT 1 FROM connections WHERE id = :id AND write_id = :write)`,
        { now: int(this.options.now()), attempt: String(attempt.id), write, id },
      ),
      sql(`SELECT id FROM connections WHERE id = :id AND write_id = :write`, { id, write }),
    ]);
    if (!result.at(-1)?.results[0]) throw new IntegrationError("integration.unauthorized");
    return id;
  }
}
