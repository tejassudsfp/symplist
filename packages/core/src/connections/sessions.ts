import { type DbClient, int, sql, uuidv7 } from "@symplist/db";
import {
  type ComposioExecutionClient,
  type ComposioSession,
  IntegrationError,
  normalizeIntegrationError,
  sessionConfiguration,
} from "@symplist/integrations";
import type { AccessPolicy } from "../access/evaluate.ts";
import { accessCondition } from "../access/sql.ts";

/** Serializes pin updates across API/worker processes, not merely inside one JS process. */
export class ComposioSessions {
  constructor(
    private readonly options: {
      db: DbClient;
      client: ComposioExecutionClient;
      policy: AccessPolicy;
      now: () => number;
    },
  ) {}

  async use(ownerId: string): Promise<ComposioSession> {
    const { db, client, now, policy } = this.options;
    const writeId = uuidv7();
    const time = now();
    const access = accessCondition({ level: "admitted", policy, userParam: "owner" });
    const result = await db.batch([
      sql(
        `INSERT INTO composio_sessions (user_id, updated_at, write_id)
        SELECT :owner, :now, :write WHERE ${access} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
        ON CONFLICT (user_id) DO NOTHING`,
        { owner: ownerId, now: int(time), write: writeId },
      ),
      sql(
        `UPDATE composio_sessions SET lease_until = :until, write_id = :write WHERE user_id = :owner
        AND lease_until <= :now AND ${access} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
        { until: int(time + 60_000), write: writeId, owner: ownerId, now: int(time) },
      ),
      sql(
        `SELECT s.*, COALESCE(c.generation, 0) AS current_generation FROM composio_sessions s
        LEFT JOIN connection_state c ON c.owner_id = s.user_id WHERE s.user_id = :owner AND s.write_id = :write`,
        { owner: ownerId, write: writeId },
      ),
      sql(
        `SELECT toolkit, connected_account_id FROM connections WHERE owner_id = :owner AND status = 'active'
        AND EXISTS (SELECT 1 FROM composio_sessions WHERE user_id = :owner AND write_id = :write)
        ORDER BY toolkit, id LIMIT 501`,
        { owner: ownerId, write: writeId },
      ),
    ]);
    const row = result[2]?.results[0];
    if (!row) throw new IntegrationError("integration.unavailable");
    const rows = result[3]?.results ?? [];
    if (rows.length > 500) {
      await this.release(ownerId, writeId);
      throw new IntegrationError("integration.unavailable");
    }
    const pins: Record<string, string[]> = {};
    for (const connection of rows) {
      const toolkit = String(connection.toolkit);
      pins[toolkit] ??= [];
      pins[toolkit].push(String(connection.connected_account_id));
    }
    const generation = Number(row.current_generation);
    let session: ComposioSession | null = null;
    let created = false;
    let committedLease = false;
    try {
      if (row.session_id) {
        try {
          session = await client.sessions.use(String(row.session_id));
        } catch (error) {
          // Recreate only a definitively missing session; network/auth errors never create another.
          if (!(error && typeof error === "object" && "status" in error && error.status === 404))
            throw error;
        }
      }
      if (!session) {
        session = await client.sessions.create(ownerId, sessionConfiguration(pins));
        created = true;
      } else if (Number(row.pinned_generation) !== generation) {
        await session.update({ connectedAccounts: pins });
      }
      const committed = await db.batch([
        sql(
          `UPDATE composio_sessions SET session_id = :session, pinned_generation = :generation,
          lease_until = 0, updated_at = :now WHERE user_id = :owner AND write_id = :write AND lease_until > :now
          AND COALESCE((SELECT generation FROM connection_state WHERE owner_id = :owner), 0) = CAST(:generation AS INTEGER)
          AND ${access} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
          {
            session: session.sessionId,
            generation: int(generation),
            now: int(now()),
            owner: ownerId,
            write: writeId,
          },
        ),
        sql(
          `SELECT session_id FROM composio_sessions WHERE user_id = :owner AND write_id = :write AND lease_until = 0
          AND pinned_generation = :generation AND session_id = :session AND ${access}`,
          {
            owner: ownerId,
            write: writeId,
            generation: int(generation),
            session: session.sessionId,
          },
        ),
      ]);
      if (!committed[1]?.results[0]) throw new IntegrationError("integration.unavailable");
      committedLease = true;
      return session;
    } catch (error) {
      if (created && session) {
        try {
          await session.delete();
        } catch {
          /* Orphan is not published or usable by this account. */
        }
      }
      throw normalizeIntegrationError(error);
    } finally {
      if (!committedLease) await this.release(ownerId, writeId);
    }
  }

  private async release(ownerId: string, writeId: string): Promise<void> {
    await this.options.db.run(
      sql(
        `UPDATE composio_sessions SET lease_until = 0 WHERE user_id = :owner AND write_id = :write`,
        { owner: ownerId, write: writeId },
      ),
    );
  }
}
