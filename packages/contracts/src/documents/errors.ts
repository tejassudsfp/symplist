import { defineErrorCodes } from "../common/errors.ts";

/**
 * Stable error codes owned by the documents feature (§9, §6), mapped to HTTP statuses. Unknown and
 * foreign tasks, revisions and sections use the common `not_found`; archived tasks `task.archived`;
 * a reused request id with other input `idempotency.mismatch`; a busy Git service `rate.limited`.
 */
export const documentsErrorCodes = defineErrorCodes({
  /** The expected base revision is not the published head; details carry the current revision (§9.2). */
  "document.conflict": 409,
  /** A baseline is unknown, unreachable or deleted; re-read the document instead of assuming no changes (§9.4). */
  "document.resync_required": 409,
  /** A cursor was issued for an earlier head; fetch the first page again (note 06). */
  "document.stale_cursor": 409,
  /** A cursor is malformed or belongs to another request. */
  "document.cursor_invalid": 400,
  /** The document would exceed `DOC_MAX_BYTES`. */
  "document.too_large": 413,
  /** The history bundle would exceed its size limit; nothing was published and no history was lost. */
  "document.history_too_large": 413,
  /** A stored document artifact is missing or failed authentication; no content is returned. */
  "document.integrity_failed": 500,
  /** The per-turn (Simon) or per-grant (MCP) retrieval budget is spent (§9.4). */
  "document.budget_exhausted": 429,
  /** A draft write is older than the stored draft (§9.3). */
  "document.draft_stale": 409,
  /** The edit cannot be applied, for example a section edit of a document beyond the parser limits. */
  "document.edit_invalid": 422,
  /** The caller may read but not write this document (a read-only grant or quick chat). */
  "document.read_only": 403,
});
