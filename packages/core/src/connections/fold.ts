import type { AccountDataKey } from "@symplist/crypto";
import { type Statement, type StatementResult, sql } from "@symplist/db";
import type { IdempotencyClaim } from "../idempotency/store.ts";

/** Structural HTTP idempotency seam; the API's folded context implements it directly. */
export interface ConnectionWriteFold {
  readonly claim: IdempotencyClaim;
  readonly statements: readonly Statement[];
  completionStatement(response: { status: number; body: unknown }, key: AccountDataKey): Statement;
  decide(
    results: readonly StatementResult[],
    key: AccountDataKey,
  ): { kind: "started" } | { kind: "replay"; body: unknown };
}

export function connectionFoldCompletion(
  fold: ConnectionWriteFold,
  response: { status: number; body: unknown },
  key: AccountDataKey,
  applied: Statement,
): Statement[] {
  const completion = fold.completionStatement(response, key);
  const release = sql(
    `DELETE FROM idempotency_records WHERE scope = :idem_scope AND user_id = :idem_user AND key = :idem_key AND write_id = :idem_write_id AND status = 'pending'`,
    fold.claim.guard.params,
  );
  return [
    {
      sql: `${completion.sql} AND (${applied.sql})`,
      params: [...completion.params, ...applied.params],
    },
    {
      sql: `${release.sql} AND NOT (${applied.sql})`,
      params: [...release.params, ...applied.params],
    },
  ];
}
