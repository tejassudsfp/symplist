import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/** Connections purge statements (§5.6). Connections, connection attempts and the Composio session record. */
export const connectionsPurgeContributor: PurgeContributor = {
  domain: "connections",
  statements: ({ userId, batchLimit }) => [
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
      OR EXISTS (SELECT 1 FROM connection_state WHERE owner_id = :owner)) AS remaining`,
      {
        owner: userId,
      },
    ),
  ],
};
