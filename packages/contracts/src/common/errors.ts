/** HTTP statuses an API error response may carry (§6). */
export type ErrorHttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 502 | 503;

/**
 * A feature's stable error codes, mapped to the HTTP status each is returned with. Codes are
 * `<area>.<reason>` strings such as `task.archived`; each feature owns its map in
 * `contracts/src/<feature>/errors.ts` (§2.3, §6).
 */
export type ErrorCodeMap = Readonly<Record<string, ErrorHttpStatus>>;

/** Declares a feature's error-code map with its literal keys preserved. */
export function defineErrorCodes<const Codes extends ErrorCodeMap>(codes: Codes): Readonly<Codes> {
  return Object.freeze(codes);
}

/** Error codes shared by every feature. */
export const commonErrorCodes = defineErrorCodes({
  not_found: 404,
  "idempotency.mismatch": 422,
  "rate.limited": 503,
});
