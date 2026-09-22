import type { ConnectionApprovalMode } from "@symplist/contracts";
import { zeroize } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { type ConnectionLifecycleProvider, IntegrationError } from "@symplist/integrations";
import type { SimonRepository } from "../simon/repository.ts";
import { connectionApprovalExpiryStatements } from "./approval-expiry.ts";
import { type ConnectionWriteFold, connectionFoldCompletion } from "./fold.ts";
import type { ConnectionActor } from "./lifecycle.ts";
import type { ComposioSessions } from "./sessions.ts";

export interface ConnectionMutationOptions {
  readonly repository: SimonRepository;
  readonly provider: ConnectionLifecycleProvider;
  readonly sessions: Pick<ComposioSessions, "use">;
  readonly changed?: (ownerId: string, connectionId: string) => Promise<void>;
}

export class ConnectionMutations {
  constructor(readonly options: ConnectionMutationOptions) {}

  /**
   * The owner's standing answer to "must Simon ask first?" for one account. Only reads are ever
   * waived, so this changes no pending approval and revokes no authority; it needs the same owner,
   * session and access proof as any other connection write, and nothing more.
   */
  async setApprovalMode(
    actor: ConnectionActor,
    connectionId: string,
    approvalMode: ConnectionApprovalMode,
    fold?: ConnectionWriteFold,
  ): Promise<{ id: string; approvalMode: ConnectionApprovalMode }> {
    if (fold && fold.claim.userId !== actor.ownerId)
      throw new IntegrationError("integration.unauthorized");
    if (approvalMode !== "all" && approvalMode !== "reads")
      throw new IntegrationError("integration.invalid_arguments");
    const repository = this.options.repository;
    const { db, now } = repository.options;
    const session = `EXISTS (SELECT 1 FROM auth_sessions WHERE id = :session AND user_id = :owner AND revoked_at IS NULL AND expires_at > :now)`;
    const live = `status IN ('active', 'needs_attention')`;
    const preflight = await db.batch([
      sql(
        `SELECT id FROM connections WHERE id = :id AND owner_id = :owner AND ${live} AND ${repository.access()} AND ${session}`,
        { id: connectionId, owner: actor.ownerId, session: actor.sessionId, now: int(now()) },
      ),
      repository.accountKeys.selectStatement(actor.ownerId),
    ]);
    const keyRow = preflight[1]?.results[0];
    if (!preflight[0]?.results[0] || !keyRow)
      throw new IntegrationError("integration.unauthorized");
    const key = repository.accountKeys.unwrapRow(keyRow);
    const write = uuidv7(now());
    const response = { id: connectionId, approvalMode };
    const effect = sql(
      `EXISTS (SELECT 1 FROM connections WHERE id = :connection AND owner_id = :owner AND write_id = :w)`,
      { connection: connectionId, owner: actor.ownerId, w: write },
    );
    try {
      const results = await db.batch([
        ...(fold?.statements ?? []),
        sql(
          `UPDATE connections SET approval_mode = :mode, updated_at = :now, write_id = :write
          WHERE id = :id AND owner_id = :owner AND ${live} AND ${repository.access()} AND ${session}
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner) ${fold ? `AND ${fold.claim.guard.exists}` : ""}`,
          {
            mode: approvalMode,
            id: connectionId,
            owner: actor.ownerId,
            now: int(now()),
            write,
            session: actor.sessionId,
            ...fold?.claim.guard.params,
          },
        ),
        ...(fold
          ? connectionFoldCompletion(fold, { status: 200, body: response }, key, effect)
          : []),
        sql(
          `SELECT 1 AS allowed WHERE ${repository.access()} AND ${session} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
          { owner: actor.ownerId, session: actor.sessionId, now: int(now()) },
        ),
        sql(`SELECT id FROM connections WHERE id = :id AND write_id = :write`, {
          id: connectionId,
          write,
        }),
      ]);
      if (!results.at(-2)?.results[0]) throw new IntegrationError("integration.unauthorized");
      const decision = fold?.decide(results, key);
      if (decision?.kind === "replay") return decision.body as typeof response;
      if (!results.at(-1)?.results[0]) throw new IntegrationError("integration.unavailable");
    } finally {
      zeroize(key.key);
    }
    await this.options.changed?.(actor.ownerId, connectionId);
    return response;
  }

  async disconnect(
    actor: ConnectionActor,
    connectionId: string,
    fold?: ConnectionWriteFold,
  ): Promise<{ id: string; status: "disconnected" }> {
    if (fold && fold.claim.userId !== actor.ownerId)
      throw new IntegrationError("integration.unauthorized");
    const repository = this.options.repository;
    const { db, now } = repository.options;
    const session = `EXISTS (SELECT 1 FROM auth_sessions WHERE id = :session AND user_id = :owner AND revoked_at IS NULL AND expires_at > :now)`;
    const preflight = await db.batch([
      sql(
        `SELECT * FROM connections WHERE id = :id AND owner_id = :owner AND ${repository.access()} AND ${session}`,
        { id: connectionId, owner: actor.ownerId, session: actor.sessionId, now: int(now()) },
      ),
      repository.accountKeys.selectStatement(actor.ownerId),
    ]);
    const connection = preflight[0]?.results[0];
    const keyRow = preflight[1]?.results[0];
    if (!connection || !keyRow) throw new IntegrationError("integration.unauthorized");
    const key = repository.accountKeys.unwrapRow(keyRow);
    const write = uuidv7(now());
    const response = { id: connectionId, status: "disconnected" as const };
    const effect = sql(
      `EXISTS (SELECT 1 FROM connections WHERE id = :connection AND owner_id = :owner AND write_id = :w)`,
      { connection: connectionId, owner: actor.ownerId, w: write },
    );
    try {
      const statements = [
        ...(fold?.statements ?? []),
        sql(
          `UPDATE connections SET status = 'disconnected', generation = generation + 1, updated_at = :now, write_id = :write
          WHERE id = :id AND owner_id = :owner AND generation = :generation AND ${repository.access()} AND ${session}
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner) ${fold ? `AND ${fold.claim.guard.exists}` : ""}`,
          {
            id: connectionId,
            owner: actor.ownerId,
            now: int(now()),
            write,
            session: actor.sessionId,
            generation: int(Number(connection.generation)),
            ...fold?.claim.guard.params,
          },
        ),
        ...connectionApprovalExpiryStatements(repository, {
          ownerId: actor.ownerId,
          connectionId,
          writeId: write,
          now: now(),
        }),
        sql(
          `INSERT INTO connection_revoke_jobs (connected_account_id, owner_id, created_at, write_id)
          SELECT connected_account_id, owner_id, :now, :write FROM connections WHERE id = :id AND owner_id = :owner AND write_id = :write
          ON CONFLICT (connected_account_id) DO NOTHING`,
          { now: int(now()), write, id: connectionId, owner: actor.ownerId },
        ),
        ...(fold
          ? connectionFoldCompletion(fold, { status: 200, body: response }, key, effect)
          : []),
        sql(
          `SELECT 1 AS allowed WHERE ${repository.access()} AND ${session} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
          { owner: actor.ownerId, session: actor.sessionId, now: int(now()) },
        ),
        sql(`SELECT id FROM connections WHERE id = :id AND write_id = :write`, {
          id: connectionId,
          write,
        }),
      ];
      const results = await db.batch(statements);
      if (!results.at(-2)?.results[0]) throw new IntegrationError("integration.unauthorized");
      const decision = fold?.decide(results, key);
      if (decision?.kind === "replay") return decision.body as typeof response;
      if (!results.at(-1)?.results[0]) throw new IntegrationError("integration.unavailable");
    } finally {
      zeroize(key.key);
    }
    // Native authority and approvals are already fenced. A provider outage does not undo revoke;
    // the ids-only cleanup job remains for the next bounded reconciliation pass.
    await this.finishRevocation(actor.ownerId, String(connection.connected_account_id)).catch(
      () => undefined,
    );
    await this.options.sessions.use(actor.ownerId).catch(() => undefined);
    await this.options.changed?.(actor.ownerId, connectionId);
    return response;
  }

  async finishRevocation(ownerId: string, accountId: string): Promise<void> {
    const { db, now } = this.options.repository.options;
    const write = uuidv7(now());
    const rows = await db.batch([
      sql(
        `UPDATE connection_revoke_jobs SET lease_until = :until, attempts = attempts + 1, write_id = :write
        WHERE owner_id = :owner AND connected_account_id = :account AND lease_until <= :now
        AND NOT EXISTS (SELECT 1 FROM connections WHERE connected_account_id = :account AND status = 'active')`,
        { until: int(now() + 60_000), write, owner: ownerId, account: accountId, now: int(now()) },
      ),
      sql(
        `SELECT 1 FROM connection_revoke_jobs WHERE owner_id = :owner AND connected_account_id = :account AND write_id = :write`,
        { owner: ownerId, account: accountId, write },
      ),
    ]);
    if (!rows[1]?.results[0]) return;
    await this.options.provider.revoke(accountId);
    await db.run(
      sql(
        `DELETE FROM connection_revoke_jobs WHERE owner_id = :owner AND connected_account_id = :account AND write_id = :write`,
        { owner: ownerId, account: accountId, write },
      ),
    );
  }
}
