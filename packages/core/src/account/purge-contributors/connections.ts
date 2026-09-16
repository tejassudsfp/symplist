import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/** Connections purge statements (§5.6). Connections, connection attempts and the Composio session record. */
export const connectionsPurgeContributor: PurgeContributor = {
  domain: "connections",
  statements: ({ userId, batchLimit }) => [
    sql(
      `DELETE FROM connections WHERE id IN
    (SELECT id FROM connections WHERE owner_id = :owner LIMIT :limit)`,
      { owner: userId, limit: int(batchLimit) },
    ),
  ],
  remaining: ({ userId }) => [
    sql("SELECT EXISTS (SELECT 1 FROM connections WHERE owner_id = :owner) AS remaining", {
      owner: userId,
    }),
  ],
};
