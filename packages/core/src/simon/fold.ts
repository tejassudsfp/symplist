import type { AccountDataKey } from "@symplist/crypto";
import { type Statement, type StatementResult, sql } from "@symplist/db";
import type { IdempotencyClaim } from "../idempotency/store.ts";
import { SimonError } from "./types.ts";

/** Trusted core SQL only. Bind names are namespaced so they cannot shadow operation identity. */
export interface SimonAuthorization {
  readonly sql: string;
  readonly params: Readonly<Record<string, string>>;
}

export function assertAuthorization(authorization?: SimonAuthorization): void {
  if (
    authorization &&
    Object.keys(authorization.params).some((name) => !name.startsWith("simon_auth_"))
  )
    throw new SimonError("internal");
  // Validate separately before combining: a predicate cannot borrow an operation's named bind.
  if (authorization) sql(authorization.sql, authorization.params);
}

/** The HTTP claim, effect and encrypted response commit in one deciding transaction. */
export interface SimonWriteFold {
  readonly authorization?: SimonAuthorization;
  readonly claim: IdempotencyClaim;
  readonly statements: readonly Statement[];
  completion(response: { status: number; body: unknown }, key: AccountDataKey): Statement;
  decide(
    results: readonly StatementResult[],
    key: AccountDataKey,
    offset: number,
  ): { kind: "started" } | { kind: "replay"; body: unknown };
}

export function assertFoldOwner(fold: SimonWriteFold | undefined, ownerId: string): void {
  if (fold && fold.claim.userId !== ownerId) throw new SimonError("not_found");
  assertAuthorization(fold?.authorization);
}

/** Append only to the store's trusted completion UPDATE, not to arbitrary caller SQL. */
export function guardedCompletion(completion: Statement, condition: Statement): Statement {
  return {
    sql: `${completion.sql} AND (${condition.sql})`,
    params: [...completion.params, ...condition.params],
  };
}

/** A refused effect must not leave a success or a pending claim behind. */
export function releaseUnapplied(fold: SimonWriteFold, applied: Statement): Statement {
  const release = sql(
    `DELETE FROM idempotency_records WHERE scope = :idem_scope AND user_id = :idem_user
      AND key = :idem_key AND write_id = :idem_write_id AND status = 'pending'`,
    fold.claim.guard.params,
  );
  return {
    sql: `${release.sql} AND NOT (${applied.sql})`,
    params: [...release.params, ...applied.params],
  };
}
