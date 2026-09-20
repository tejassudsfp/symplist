import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/**
 * Search purge statements (§5.6 step 4): the account's unapplied `search_intents` in bounded batches,
 * then its `search_indexes` row. The encrypted index objects under `u/<userId>/search/` are deleted by
 * the purge's R2 step, which removes the whole account prefix before any D1 rows (step 3); after the
 * crypto-shred they were already undecryptable. Idempotent: a resumed purge deletes what is left.
 */
export const searchPurgeContributor: PurgeContributor = {
  domain: "search",
  statements: ({ userId, batchLimit }) => {
    const params = { user: userId, limit: int(batchLimit) };
    return [
      sql(
        `DELETE FROM search_intents WHERE rowid IN (
           SELECT rowid FROM search_intents WHERE owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
      sql(`DELETE FROM search_indexes WHERE owner_id = :user`, { user: userId }),
    ];
  },
  remaining: ({ userId }) => [
    sql(
      `SELECT (
         EXISTS (SELECT 1 FROM search_intents WHERE owner_id = :user)
         OR EXISTS (SELECT 1 FROM search_indexes WHERE owner_id = :user)
       ) AS remaining`,
      { user: userId },
    ),
  ],
};
