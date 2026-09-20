import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/** Connections purge statements (§5.6). Connections, connection attempts and the Composio session record. */
export const connectionsPurgeContributor: PurgeContributor = {
  domain: "connections",
  purgeProvider: async ({ userId, composioUserId }, { db, connections }) => {
    const snapshot = await db.first(
      sql(
        `SELECT
      (SELECT session_id FROM composio_sessions WHERE user_id = :owner) AS session_id,
      (EXISTS (SELECT 1 FROM connections WHERE owner_id = :owner)
      OR EXISTS (SELECT 1 FROM connection_attempts WHERE user_id = :owner)
      OR EXISTS (SELECT 1 FROM connection_revoke_jobs WHERE owner_id = :owner)
      OR EXISTS (SELECT 1 FROM composio_sessions WHERE user_id = :owner)) AS has_provider_state`,
        { owner: userId },
      ),
    );
    if (!connections) return snapshot?.has_provider_state ? "incomplete" : "done";
    try {
      // Re-read the first page after deleting, rather than carrying a cursor through a shrinking
      // result set. Twenty deletions is one bounded invocation; the purge runner resumes it.
      const page = await connections.accounts(composioUserId);
      for (const account of page.items.slice(0, 20)) await connections.revoke(account.id);
      if (page.items.length || page.cursor) return "incomplete";
      if (typeof snapshot?.session_id === "string")
        await connections.deleteSession(snapshot.session_id);
      return "done";
    } catch {
      return "incomplete";
    }
  },
  statements: ({ userId, batchLimit }) => [
    sql(
      `DELETE FROM connection_revoke_jobs WHERE connected_account_id IN (SELECT connected_account_id FROM connection_revoke_jobs WHERE owner_id = :owner LIMIT :limit)`,
      { owner: userId, limit: int(batchLimit) },
    ),
    sql(
      `DELETE FROM connection_attempts WHERE id IN (SELECT id FROM connection_attempts WHERE user_id = :owner LIMIT :limit)`,
      { owner: userId, limit: int(batchLimit) },
    ),
    sql("DELETE FROM composio_sessions WHERE user_id = :owner", { owner: userId }),
    sql(
      `DELETE FROM connections WHERE id IN
    (SELECT id FROM connections WHERE owner_id = :owner LIMIT :limit)`,
      { owner: userId, limit: int(batchLimit) },
    ),
    sql(
      `DELETE FROM connection_state WHERE owner_id = :owner AND NOT EXISTS (SELECT 1 FROM connections WHERE owner_id = :owner)`,
      { owner: userId },
    ),
  ],
  remaining: ({ userId }) => [
    sql(
      `SELECT (EXISTS (SELECT 1 FROM connections WHERE owner_id = :owner)
      OR EXISTS (SELECT 1 FROM connection_attempts WHERE user_id = :owner)
      OR EXISTS (SELECT 1 FROM composio_sessions WHERE user_id = :owner)
      OR EXISTS (SELECT 1 FROM connection_revoke_jobs WHERE owner_id = :owner)
      OR EXISTS (SELECT 1 FROM connection_state WHERE owner_id = :owner)) AS remaining`,
      {
        owner: userId,
      },
    ),
  ],
};
