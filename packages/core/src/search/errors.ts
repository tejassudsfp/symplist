import type { ErrorCode } from "@symplist/contracts";

/** The search codes a search service call can fail with (contracts `searchErrorCodes`). */
export type SearchServiceErrorCode = Extract<
  ErrorCode,
  | "search.cursor_stale"
  | "search.cursor_invalid"
  | "search.filter_unavailable"
  | "search.unavailable"
>;

/**
 * A search request that cannot be answered. Runtimes map it to their error envelope with the same
 * code; `details` holds only numbers (the current index generation for a stale cursor).
 */
export class SearchServiceError extends Error {
  readonly code: SearchServiceErrorCode;
  readonly details: Readonly<Record<string, number>> | undefined;

  constructor(code: SearchServiceErrorCode, details?: Readonly<Record<string, number>>) {
    super(code);
    this.name = "SearchServiceError";
    this.code = code;
    this.details = details;
  }
}
