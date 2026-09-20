import { int, type Statement, sql, uuidv7 } from "@symplist/db";
import {
  type ConnectionLifecycleProvider,
  IntegrationError,
  type ProviderAccount,
} from "@symplist/integrations";
import type { SimonRepository } from "../simon/repository.ts";
import { connectionApprovalExpiryStatements } from "./approval-expiry.ts";
import type { ComposioSessions } from "./sessions.ts";

export interface ConnectionExecutorFence {
  readonly mode: "local" | "durable";
  readonly generation: number;
}

function executor(fence?: ConnectionExecutorFence) {
  return fence
    ? {
        sql: "EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND mode = :reconcile_mode AND generation = :reconcile_generation)",
        params: { reconcile_mode: fence.mode, reconcile_generation: int(fence.generation) },
      }
    : { sql: "1 = 1", params: {} };
}

const inactive = new Set(["EXPIRED", "FAILED", "REVOKED", "INACTIVE"]);
const chunkSize = 8;
const cycleId = "connections-reconcile";
const cycleLeaseMs = 15 * 60_000;

/** Shared local/Trigger maintenance. Every deciding write is fenced, with bounded D1 batches. */
export class ConnectionReconciler {
  constructor(
    readonly options: {
      repository: SimonRepository;
      provider: ConnectionLifecycleProvider;
      sessions: Pick<ComposioSessions, "use">;
      changed?: (owner: string, connection: string) => Promise<void>;
    },
  ) {}

  async owner(ownerId: string, fence?: ConnectionExecutorFence): Promise<number> {
    const { repository, provider } = this.options;
    const { db, now } = repository.options;
    const guard = executor(fence);
    const native = await db.all(
      sql(
        `SELECT id, connected_account_id, generation, status FROM connections WHERE owner_id = :owner AND ${guard.sql} LIMIT 501`,
        { owner: ownerId, ...guard.params },
      ),
    );
    if (native.length > 500) throw new IntegrationError("integration.unavailable");
    if (!(await this.current(fence))) return 0;
    const accounts: ProviderAccount[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await provider.accounts(ownerId, cursor);
      accounts.push(...result.items);
      if (accounts.length > 2000) throw new IntegrationError("integration.invalid_response");
      if (!result.cursor) break;
      if (page === 19 || cursors.has(result.cursor))
        throw new IntegrationError("integration.invalid_response");
      cursors.add(result.cursor);
      cursor = result.cursor;
    }
    const indexed = new Map(accounts.map((account) => [account.id, account]));
    const changes = native.filter(
      (row) =>
        row.status === "active" &&
        inactive.has(indexed.get(String(row.connected_account_id))?.status ?? ""),
    );
    let updated = 0;
    for (let offset = 0; offset < changes.length; offset += chunkSize) {
      const batch = changes.slice(offset, offset + chunkSize);
      const write = uuidv7(now());
      const statements: Statement[] = [];
      for (const row of batch) {
        statements.push(
          sql(
            `UPDATE connections SET status = 'needs_attention', generation = generation + 1, updated_at = :now, write_id = :write
          WHERE id = :id AND owner_id = :owner AND connected_account_id = :account AND generation = :generation AND status = 'active' AND ${guard.sql}`,
            {
              now: int(now()),
              write,
              id: String(row.id),
              owner: ownerId,
              account: String(row.connected_account_id),
              generation: int(Number(row.generation)),
              ...guard.params,
            },
          ),
          ...connectionApprovalExpiryStatements(repository, {
            ownerId,
            connectionId: String(row.id),
            writeId: write,
            now: now(),
          }),
        );
      }
      statements.push(
        sql("SELECT id FROM connections WHERE owner_id = :owner AND write_id = :write LIMIT 8", {
          owner: ownerId,
          write,
        }),
      );
      const result = await db.batch(statements);
      for (const row of result.at(-1)?.results ?? []) {
        updated++;
        await this.options.changed?.(ownerId, String(row.id));
      }
    }
    // A live attempt protects an account until callback attestation finishes or its ten-minute
    // expiry. Otherwise a daily pass concurrent with the callback could destroy a valid link.
    const unknown = accounts.filter(
      (account) =>
        account.status === "ACTIVE" &&
        !native.some((row) => row.connected_account_id === account.id && row.status === "active"),
    );
    for (let offset = 0; offset < unknown.length; offset += chunkSize) {
      await db.batch(
        unknown.slice(offset, offset + chunkSize).map((account) =>
          sql(
            `INSERT INTO connection_revoke_jobs (connected_account_id, owner_id, created_at, write_id)
        SELECT :account, :owner, :now, :write WHERE ${guard.sql}
        AND EXISTS (SELECT 1 FROM users WHERE id = :owner)
        AND NOT EXISTS (SELECT 1 FROM connections WHERE connected_account_id = :account AND status = 'active')
        AND NOT EXISTS (SELECT 1 FROM connection_attempts WHERE user_id = :owner AND connected_account_id = :account AND status IN ('starting', 'pending', 'completing') AND expires_at > :now)
        ON CONFLICT (connected_account_id) DO NOTHING`,
            {
              account: account.id,
              owner: ownerId,
              now: int(now()),
              write: uuidv7(now()),
              ...guard.params,
            },
          ),
        ),
      );
    }
    if (updated > 0 && (await this.current(fence)))
      await this.options.sessions.use(ownerId).catch(() => undefined);
    return updated;
  }

  async current(fence?: ConnectionExecutorFence): Promise<boolean> {
    if (!fence) return true;
    const guard = executor(fence);
    return !!(await this.options.repository.options.db.first(
      sql(`SELECT 1 WHERE ${guard.sql}`, guard.params),
    ));
  }

  private async claimCycle(
    fence: ConnectionExecutorFence,
  ): Promise<{ token: string; cursor: string } | null> {
    const { db, now } = this.options.repository.options;
    const guard = executor(fence);
    const token = uuidv7(now());
    const time = now();
    const results = await db.batch([
      sql(
        `INSERT INTO cleanup_cursors(id,owner_id,object_cursor,lease_token,lease_until,write_id)
        SELECT :id,'',NULL,:token,:until,:token WHERE ${guard.sql}
        ON CONFLICT(id) DO UPDATE SET lease_token=:token,lease_until=:until,write_id=:token
        WHERE cleanup_cursors.lease_until<=:now AND ${guard.sql}`,
        {
          id: cycleId,
          token,
          until: int(time + cycleLeaseMs),
          now: int(time),
          ...guard.params,
        },
      ),
      sql(
        "SELECT owner_id FROM cleanup_cursors WHERE id=:id AND lease_token=:token AND lease_until>:now",
        { id: cycleId, token, now: int(time) },
      ),
    ]);
    const row = results[1]?.results[0];
    return row ? { token, cursor: String(row.owner_id) } : null;
  }

  private async saveCycle(
    fence: ConnectionExecutorFence,
    token: string,
    cursor: string,
    release: boolean,
  ): Promise<boolean> {
    const { db, now } = this.options.repository.options;
    const guard = executor(fence);
    const time = now();
    const write = uuidv7(time);
    const results = await db.batch([
      sql(
        `UPDATE cleanup_cursors SET owner_id=:cursor,lease_until=:until,write_id=:write
        WHERE id=:id AND lease_token=:token AND lease_until>:now AND ${guard.sql}`,
        {
          id: cycleId,
          cursor,
          token,
          now: int(time),
          until: int(release ? 0 : time + cycleLeaseMs),
          write,
          ...guard.params,
        },
      ),
      sql("SELECT 1 AS saved FROM cleanup_cursors WHERE id=:id AND write_id=:write", {
        id: cycleId,
        write,
      }),
    ]);
    return results[1]?.results[0]?.saved === 1;
  }

  /** Claims twenty ids at once, deletes upstream in-process, then acknowledges in one batch. */
  async drain(fence?: ConnectionExecutorFence, ownerId?: string): Promise<number> {
    const { db, now } = this.options.repository.options;
    const guard = executor(fence);
    const write = uuidv7(now());
    const rows = await db.all(
      sql(
        `UPDATE connection_revoke_jobs SET lease_until = :until, attempts = attempts + 1, write_id = :write
      WHERE connected_account_id IN (SELECT j.connected_account_id FROM connection_revoke_jobs j
        WHERE j.lease_until <= :now ${ownerId ? "AND j.owner_id = :owner" : ""}
        AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.connected_account_id = j.connected_account_id AND c.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM connection_attempts a WHERE a.user_id = j.owner_id AND a.connected_account_id = j.connected_account_id AND a.status IN ('starting', 'pending', 'completing') AND a.expires_at > :now)
        ORDER BY j.created_at, j.connected_account_id LIMIT 20) AND ${guard.sql}
      RETURNING connected_account_id, owner_id`,
        {
          until: int(now() + 60_000),
          now: int(now()),
          write,
          ...(ownerId ? { owner: ownerId } : {}),
          ...guard.params,
        },
      ),
    );
    const done: string[] = [];
    for (let offset = 0; offset < rows.length; offset += 5) {
      if (!(await this.current(fence))) break;
      await Promise.all(
        rows.slice(offset, offset + 5).map(async (row) => {
          try {
            await this.options.provider.revoke(String(row.connected_account_id));
            done.push(String(row.connected_account_id));
          } catch {
            // Preserve the ids-only lease for retry; never return provider details.
          }
        }),
      );
    }
    if (done.length)
      await db.batch(
        done.map((account) =>
          sql(
            `DELETE FROM connection_revoke_jobs WHERE connected_account_id = :account AND write_id = :write AND ${guard.sql}`,
            { account, write, ...guard.params },
          ),
        ),
      );
    return done.length;
  }

  async run(
    fence: ConnectionExecutorFence,
    signal?: AbortSignal,
  ): Promise<{ owners: number; updated: number; revoked: number }> {
    const { db, now } = this.options.repository.options;
    const guard = executor(fence);
    const count = { owners: 0, updated: 0, revoked: 0 };
    const claim = await this.claimCycle(fence);
    if (!claim) return count;
    let cursor = claim.cursor;
    let released = false;
    try {
      let complete = false;
      while (!signal?.aborted && (await this.current(fence))) {
        const owners = await db.all(
          sql(
            `SELECT id FROM users WHERE id > :cursor AND ${guard.sql} AND (
          EXISTS (SELECT 1 FROM connections WHERE owner_id = users.id) OR
          EXISTS (SELECT 1 FROM connection_attempts WHERE user_id = users.id) OR
          EXISTS (SELECT 1 FROM composio_sessions WHERE user_id = users.id)) ORDER BY id LIMIT 25`,
            { cursor, ...guard.params },
          ),
        );
        if (!owners.length) {
          complete = true;
          break;
        }
        for (const row of owners) {
          if (signal?.aborted) return count;
          count.updated += await this.owner(String(row.id), fence);
          count.owners++;
          cursor = String(row.id);
          if (!(await this.saveCycle(fence, claim.token, cursor, false))) return count;
        }
      }
      if (complete && !signal?.aborted && (await this.current(fence))) {
        await db.run(
          sql(
            `UPDATE connection_attempts SET status = 'expired', updated_at = :now, write_id = :write
          WHERE id IN (SELECT id FROM connection_attempts WHERE status IN ('starting', 'pending', 'completing') AND expires_at <= :now LIMIT 100) AND ${guard.sql}`,
            { now: int(now()), write: uuidv7(now()), ...guard.params },
          ),
        );
        count.revoked = await this.drain(fence);
        released = await this.saveCycle(fence, claim.token, "", true);
      }
      return count;
    } finally {
      if (!released) await this.saveCycle(fence, claim.token, cursor, true).catch(() => false);
    }
  }
}
