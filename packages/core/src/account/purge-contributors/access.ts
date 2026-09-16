import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/**
 * Access purge statements (§5.6 step 4), bounded per statement and idempotent. The account's beta
 * access grants reference `users` and are deleted. Invite labels the account wrote as an
 * administrator were encrypted under its shredded key and can never be read again, so the
 * ciphertext and its owner id are cleared. Redemption rows are kept on purpose: a redemption is a
 * seat, seats are never refunded and seat numbers must stay contiguous (§5.4); they hold only
 * opaque ids, like `beta_admin_events`, and administrators see "Deleted account". OTP challenges,
 * auth sessions and deletion authorizations belong to the `account` contributor.
 */
export const accessPurgeContributor: PurgeContributor = {
  domain: "access",
  statements: ({ userId, batchLimit }) => {
    const params = { user: userId, limit: int(batchLimit) };
    return [
      sql(
        `DELETE FROM beta_access_grants WHERE rowid IN (
           SELECT rowid FROM beta_access_grants WHERE user_id = :user LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
      sql(
        `UPDATE beta_invites SET label_enc = NULL, label_owner_id = NULL
         WHERE rowid IN (
           SELECT rowid FROM beta_invites WHERE label_owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
    ];
  },
  remaining: ({ userId }) => [
    sql(
      `SELECT (
         EXISTS (SELECT 1 FROM beta_access_grants WHERE user_id = :user)
         OR EXISTS (SELECT 1 FROM beta_invites WHERE label_owner_id = :user)
       ) AS remaining`,
      { user: userId },
    ),
  ],
};
