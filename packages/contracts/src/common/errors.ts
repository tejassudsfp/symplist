import { isStableCode } from "./primitives.ts";

/** HTTP statuses an API error response may carry (§6). */
export type ErrorHttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 502 | 503;

const errorHttpStatuses: ReadonlySet<number> = new Set<ErrorHttpStatus>([
  400, 401, 403, 404, 409, 410, 413, 422, 429, 500, 502, 503,
]);

/**
 * A feature's stable error codes, mapped to the HTTP status each is returned with. Codes are
 * `<area>.<reason>` strings such as `task.archived`; each feature owns its map in
 * `contracts/src/<feature>/errors.ts` (§2.3, §6).
 */
export type ErrorCodeMap = Readonly<Record<string, ErrorHttpStatus>>;

/**
 * Declares a feature's error-code map with its literal keys preserved. Throws when a code is not a
 * stable dotted identifier or a status is not an error status, so a malformed map fails at import.
 */
export function defineErrorCodes<const Codes extends ErrorCodeMap>(codes: Codes): Readonly<Codes> {
  for (const [code, status] of Object.entries(codes)) {
    if (!isStableCode(code)) {
      throw new Error(`Invalid error code "${code}": use lowercase dotted identifiers`);
    }
    if (!errorHttpStatuses.has(status)) {
      throw new Error(`Invalid HTTP status for error code "${code}"`);
    }
  }
  return Object.freeze(codes);
}

/**
 * Error codes owned by the foundation and shared by every feature (§5, §6, §6.1, §2.1). Features
 * never redeclare these; the composed index fails its uniqueness test when they do.
 */
export const commonErrorCodes = defineErrorCodes({
  /** Unknown and unauthorized resources return the same shape, without names (§6). */
  not_found: 404,
  /** The request failed schema validation; `details` follows `validationErrorDetailsSchema`. */
  validation: 400,
  /** An unexpected failure; the message never carries internal detail. */
  internal: 500,
  /** The request body exceeds the api's size limit; the body is never read further or logged. */
  "request.too_large": 413,

  /** No valid session: missing, expired or revoked (§5.1, §5.2). */
  "auth.session_required": 401,
  /** `Origin` is missing or not allowlisted for the route class (§5.3). */
  "auth.origin_forbidden": 403,
  /** `X-Symplist-CSRF` is missing or does not match the session-bound token (§5.3). */
  "auth.csrf_invalid": 403,

  /** The email address is not verified yet (§5.4). */
  "access.unverified": 403,
  /** Verified but not admitted to the closed beta (§5.4). */
  "access.locked": 403,
  /** Access was taken away by a relock (§5.4, §5.5). */
  "access.relocked": 403,
  /** The account is suspended (§5.4, §5.5). */
  "access.suspended": 403,
  /** The route requires the `admin` access level (§5.4). */
  "access.admin_required": 403,

  /** A mutation with side effects was sent without an `Idempotency-Key` header (§6.1). */
  "idempotency.key_required": 400,
  /** The `Idempotency-Key` header does not match `idempotencyKeySchema`. */
  "idempotency.key_invalid": 400,
  /** The key was already used with a different request fingerprint (§6.1, decision F8). */
  "idempotency.mismatch": 422,
  /** The first request with this key has not finished; retry after it completes. */
  "idempotency.in_progress": 409,

  /** A request budget, circuit or semaphore is exhausted; `details.retryAfter` is in seconds (§3.1, §4.3). */
  "rate.limited": 503,

  /** The targeted task is archived; every task write is guarded (§2.1). */
  "task.archived": 409,
  /** Completing the task would leave an active run; resend with `stopRun: true` (§2.1). */
  "task.run_active": 409,
});
