import { defineErrorCodes } from "../common/errors.ts";

/** Stable error codes owned by the search feature (§10.1 and §10.2, §6), mapped to HTTP statuses. */
export const searchErrorCodes = defineErrorCodes({
  /**
   * The cursor was issued for an index generation or pending change set this api no longer holds, so
   * the next page could repeat or skip results; restart from the first page. `details.indexGeneration`
   * is the current generation.
   */
  "search.cursor_stale": 409,
  /** The cursor is malformed or belongs to a different query or scope. */
  "search.cursor_invalid": 400,
  /** A filter the request names cannot be evaluated yet (deadline filters until scheduling exists). */
  "search.filter_unavailable": 422,
  /** The encrypted index could not be read right now (storage or decryption unavailable); retry. */
  "search.unavailable": 503,
});
