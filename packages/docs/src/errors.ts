/**
 * Stable document error codes (§6, §9). Each is declared with its HTTP status in
 * `@symplist/contracts` (`documentsErrorCodes`) or the common codes; errors carry only the code and
 * structured, non-secret details (revisions, generations, counts), never document text.
 */
export type DocumentErrorCode =
  /** The expected base revision is not the published head. */
  | "document.conflict"
  /** A baseline is unknown, unreachable or deleted; the caller must re-read the document. */
  | "document.resync_required"
  /** A cursor was issued for an earlier head; the caller must fetch the first page again. */
  | "document.stale_cursor"
  /** A cursor is malformed or does not belong to this request. */
  | "document.cursor_invalid"
  /** The document would exceed `DOC_MAX_BYTES`. */
  | "document.too_large"
  /** The history bundle would exceed its size limit; nothing was published and no history is lost. */
  | "document.history_too_large"
  /** A published artifact is missing or failed authentication. */
  | "document.integrity_failed"
  /** The per-turn (or per-grant) retrieval budget is spent. */
  | "document.budget_exhausted"
  /** A draft write is older than the stored draft. */
  | "document.draft_stale"
  /** The edit cannot be applied, for example a section edit of a document beyond the parser limits. */
  | "document.edit_invalid"
  /** The actor may not write (a read-only grant or quick chat). */
  | "document.read_only"
  | "not_found"
  | "task.archived"
  | "idempotency.mismatch"
  | "rate.limited";

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>> | undefined;
  /** For `rate.limited`: seconds before retrying. */
  readonly retryAfter: number | undefined;

  constructor(
    code: DocumentErrorCode,
    options: {
      readonly details?: Readonly<Record<string, string | number | boolean | null>>;
      readonly retryAfter?: number;
    } = {},
  ) {
    super(code);
    this.name = "DocumentError";
    this.code = code;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
  }
}

export function isDocumentError(value: unknown, code?: DocumentErrorCode): value is DocumentError {
  return value instanceof DocumentError && (code === undefined || value.code === code);
}
