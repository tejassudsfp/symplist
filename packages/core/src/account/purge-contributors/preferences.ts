import { assertIdentifier, int, sql } from "@symplist/db";
import { preferenceTables } from "../../preferences/service.ts";
import type { PurgeContributor } from "./types.ts";

/**
 * Preferences purge statements (§5.6). The account's preference rows, bounded per pass, from every
 * table a group can live in: the foundation `user_preferences` and the additive tables later groups
 * use because SQLite cannot widen its `"group"` CHECK without breaking the expand-only rule (§3.4).
 */
export const preferencesPurgeContributor: PurgeContributor = {
  domain: "preferences",
  statements: ({ userId, batchLimit }) =>
    preferenceTables.map((name) => {
      const table = assertIdentifier(name);
      return sql(
        `DELETE FROM ${table} WHERE rowid IN (
           SELECT rowid FROM ${table} WHERE owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
        { user: userId, limit: int(batchLimit) },
      );
    }),
  remaining: ({ userId }) =>
    preferenceTables.map((name) =>
      sql(
        `SELECT EXISTS (SELECT 1 FROM ${assertIdentifier(name)} WHERE owner_id = :user) AS remaining`,
        { user: userId },
      ),
    ),
};
