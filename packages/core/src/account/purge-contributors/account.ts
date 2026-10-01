import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/**
 * Account purge statements (§5.6). Auth sessions, OTP challenges and account deletion authorizations,
 * children first: authorizations reference challenges and sessions, and challenges reference
 * sessions. Also removes abuse counters keyed by the user id and, defensively, any `account_keys` row:
 * the deletion batch already shredded it and provisioning refuses accounts being deleted, but a
 * leftover row would block the `users` delete through its foreign key.
 *
 * The account's bug reports go too, and here the delete is the whole of the shred rather than a
 * belt-and-braces one. `bugs.report_enc` is not under the account data key — it cannot be, because a
 * signed-out visitor can file a report and has no such key — so shredding the key leaves the text
 * readable and only removing the rows removes it (`migrations/0019_bug_reports.sql`). Reports filed
 * with nobody signed in have no `reporter_id` and belong to no account, so nothing here touches them.
 */
export const accountPurgeContributor: PurgeContributor = {
  domain: "account",
  statements: ({ userId, batchLimit }) => {
    const params = { user: userId, limit: int(batchLimit) };
    return [
      sql(
        `DELETE FROM account_delete_authorizations WHERE rowid IN (
           SELECT rowid FROM account_delete_authorizations WHERE user_id = :user LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
      sql(
        `DELETE FROM otp_challenges WHERE rowid IN (
           SELECT rowid FROM otp_challenges WHERE user_id = :user
             AND NOT EXISTS (SELECT 1 FROM account_delete_authorizations a WHERE a.user_id = :user)
           LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
      sql(
        `DELETE FROM auth_sessions WHERE rowid IN (
           SELECT rowid FROM auth_sessions WHERE user_id = :user
             AND NOT EXISTS (SELECT 1 FROM otp_challenges c WHERE c.user_id = :user)
           LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
      sql(`DELETE FROM account_keys WHERE owner_id = :user`, { user: userId }),
      sql(
        `DELETE FROM abuse_counters WHERE rowid IN (
           SELECT rowid FROM abuse_counters WHERE subject = :user LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
      sql(
        `DELETE FROM bugs WHERE rowid IN (
           SELECT rowid FROM bugs WHERE reporter_id = :user LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
    ];
  },
  remaining: ({ userId }) => [
    sql(
      `SELECT (
         EXISTS (SELECT 1 FROM account_delete_authorizations WHERE user_id = :user)
         OR EXISTS (SELECT 1 FROM otp_challenges WHERE user_id = :user)
         OR EXISTS (SELECT 1 FROM auth_sessions WHERE user_id = :user)
         OR EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :user)
         OR EXISTS (SELECT 1 FROM abuse_counters WHERE subject = :user)
         OR EXISTS (SELECT 1 FROM bugs WHERE reporter_id = :user)
       ) AS remaining`,
      { user: userId },
    ),
  ],
};
