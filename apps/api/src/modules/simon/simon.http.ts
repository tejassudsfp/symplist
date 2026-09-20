import { isErrorCode } from "@symplist/contracts";
import { AccountKeyUnavailableError } from "@symplist/core/account";
import type { SimonWriteFold } from "@symplist/core/simon";
import { SimonError } from "@symplist/core/simon";
import { IntegrationError } from "@symplist/integrations";
import type { Request } from "express";
import { ApiError } from "../../common/errors/api-error.ts";
import { foldedIdempotencyOf } from "../../common/idempotency/idempotency.interceptor.ts";

export function simonWriteFold(req: Request): SimonWriteFold {
  const fold = foldedIdempotencyOf(req);
  return {
    claim: fold.claim,
    statements: fold.statements,
    completion: (response, key) => fold.completionStatement(response, key),
    decide: (results, key, offset) => fold.decide(results, key, offset),
  };
}

export async function simonCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AccountKeyUnavailableError) throw ApiError.notFound();
    if (error instanceof SimonError)
      throw new ApiError(isErrorCode(error.code) ? error.code : "internal");
    if (error instanceof IntegrationError) {
      const retryAfter = error.details.retryAfter;
      throw new ApiError(isErrorCode(error.code) ? error.code : "internal", {
        details: { ...error.details },
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });
    }
    throw error;
  }
}
