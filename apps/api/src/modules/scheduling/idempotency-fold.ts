import type { TaskWriteFold } from "@symplist/core/tasks";
import type { Request } from "express";
import { foldedIdempotencyOf } from "../../common/idempotency/idempotency.interceptor.ts";

/** Scheduling folds the platform claim into its deciding write, without importing another feature. */
export function schedulingWriteFold(req: Request): TaskWriteFold {
  const fold = foldedIdempotencyOf(req);
  return {
    claim: fold.claim,
    statements: fold.statements,
    completion: (response, key) => fold.completionStatement(response, key),
    decide: (results, key, offset) => fold.decide(results, key, offset),
  };
}
