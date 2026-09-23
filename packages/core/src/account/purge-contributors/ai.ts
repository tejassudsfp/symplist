import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/**
 * Provider keys and model choices (§5.6, §8.6).
 *
 * The key ciphertext dies with the account data key anyway — deleting the wrapped key is the
 * crypto-shred — but the rows are deleted rather than left unreadable, because the promise is that
 * an owner's rows are gone, not merely that nobody can open them.
 */
export const aiPurgeContributor: PurgeContributor = {
  domain: "ai",
  statements: ({ userId, batchLimit }) => [
    sql(
      `DELETE FROM ai_provider_keys WHERE rowid IN (
         SELECT rowid FROM ai_provider_keys WHERE owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
      { user: userId, limit: int(batchLimit) },
    ),
    sql(`DELETE FROM ai_model_choices WHERE owner_id = :user`, { user: userId }),
  ],
  remaining: ({ userId }) => [
    sql(`SELECT EXISTS (SELECT 1 FROM ai_provider_keys WHERE owner_id = :user) AS remaining`, {
      user: userId,
    }),
    sql(`SELECT EXISTS (SELECT 1 FROM ai_model_choices WHERE owner_id = :user) AS remaining`, {
      user: userId,
    }),
  ],
};
