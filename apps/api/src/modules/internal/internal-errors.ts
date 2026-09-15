import { HttpException } from "@nestjs/common";
import { uuidv7 } from "@symplist/db";

type InternalErrorCode = "not_found" | "validation" | "internal" | "rate.limited";

const messages: Readonly<Record<InternalErrorCode, string>> = {
  not_found: "Not found.",
  validation: "The request is invalid.",
  internal: "Something went wrong.",
  "rate.limited": "Try again later.",
};

/**
 * The §6 error envelope for internal endpoints. Signature, freshness, replay and ownership failures
 * all return the same `not_found` shape, so an unauthenticated caller learns nothing.
 */
export function internalError(
  status: 400 | 404 | 413 | 500 | 503,
  code: InternalErrorCode,
  retryAfter?: number,
): HttpException {
  return new HttpException(
    {
      error: {
        code,
        message: messages[code],
        ...(retryAfter === undefined ? {} : { details: { retryAfter } }),
        requestId: uuidv7(),
      },
    },
    status,
  );
}
