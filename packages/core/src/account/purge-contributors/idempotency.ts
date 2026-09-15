import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/** Idempotency purge statements (§5.6). Idempotency records. */
export const idempotencyPurgeContributor: PurgeContributor = {
  domain: "idempotency",
  statements: ({ userId, batchLimit }) => [
    sql(
      `DELETE FROM idempotency_records WHERE rowid IN (
         SELECT rowid FROM idempotency_records WHERE user_id = :user LIMIT CAST(:limit AS INTEGER))`,
      { user: userId, limit: int(batchLimit) },
    ),
  ],
  remaining: ({ userId }) => [
    sql(`SELECT EXISTS (SELECT 1 FROM idempotency_records WHERE user_id = :user) AS remaining`, {
      user: userId,
    }),
  ],
};
