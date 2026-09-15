import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/** Preferences purge statements (§5.6). The account's `user_preferences` rows, bounded per pass. */
export const preferencesPurgeContributor: PurgeContributor = {
  domain: "preferences",
  statements: ({ userId, batchLimit }) => [
    sql(
      `DELETE FROM user_preferences WHERE rowid IN (
         SELECT rowid FROM user_preferences WHERE owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
      { user: userId, limit: int(batchLimit) },
    ),
  ],
  remaining: ({ userId }) => [
    sql(`SELECT EXISTS (SELECT 1 FROM user_preferences WHERE owner_id = :user) AS remaining`, {
      user: userId,
    }),
  ],
};
