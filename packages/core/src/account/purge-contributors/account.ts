import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/**
 * Account purge statements (§5.6). Auth sessions, OTP challenges and account deletion authorizations,
 * children first: authorizations reference challenges and sessions, and challenges reference
 * sessions. Also removes abuse counters keyed by the user id.
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
      sql(
        `DELETE FROM abuse_counters WHERE rowid IN (
           SELECT rowid FROM abuse_counters WHERE subject = :user LIMIT CAST(:limit AS INTEGER))`,
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
         OR EXISTS (SELECT 1 FROM abuse_counters WHERE subject = :user)
       ) AS remaining`,
      { user: userId },
    ),
  ],
};
