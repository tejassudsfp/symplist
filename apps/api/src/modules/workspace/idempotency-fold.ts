import type { TaskWriteFold } from "@symplist/core/tasks";
import type { Request } from "express";
import { foldedIdempotencyOf } from "../../common/idempotency/idempotency.interceptor.ts";

/**
 * The request's folded `Idempotency-Key` claim (§6.1, decision CZ.11) in the shape `core/tasks`
 * folds into its write batch. The interceptor's `decide` throws `idempotency.mismatch` and
 * `idempotency.in_progress`, and records the live status from `completion`.
 */
export function taskWriteFoldOf(req: Request): TaskWriteFold {
  const folded = foldedIdempotencyOf(req);
  return {
    claim: folded.claim,
    statements: folded.statements,
    completion: (response, key) => folded.completionStatement(response, key),
    decide: (results, key, offset) => folded.decide(results, key, offset),
  };
}
