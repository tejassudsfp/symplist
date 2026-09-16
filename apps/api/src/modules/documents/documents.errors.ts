import type { ErrorCode } from "@symplist/contracts";
import { DocumentAccessDeniedError } from "@symplist/core/documents";
import { DocumentError, isGitError, markdown } from "@symplist/docs";
import { ApiError } from "../../common/errors/api-error.ts";

/** Safe, fixed texts for the documents codes; never document content or names (§6). */
const messages: Partial<Record<ErrorCode, string>> = {
  "document.conflict": "The page changed since this edit started",
  "document.resync_required": "That revision is no longer available; reload the page",
  "document.stale_cursor": "The page changed; start from the first page again",
  "document.cursor_invalid": "The cursor is not valid for this request",
  "document.too_large": "The page is too large",
  "document.history_too_large": "The page history is too large to save another version",
  "document.integrity_failed": "The page could not be read",
  "document.budget_exhausted": "The reading budget for this turn is used up",
  "document.draft_stale": "A newer draft is already saved",
  "document.edit_invalid": "The edit could not be applied",
  "document.read_only": "This page cannot be changed here",
  "task.archived": "The task is archived",
};

/**
 * Maps document service failures to the §6 envelope: document codes with their structured details,
 * access denials with their access code, a busy or slow Git service to `rate.limited`. Anything else
 * is rethrown for the global filter (which answers `internal` without detail).
 */
export function toDocumentApiError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof DocumentError) {
    if (error.code === "rate.limited") return ApiError.rateLimited(error.retryAfter ?? 1);
    const options: { message?: string; details?: Record<string, unknown> } = {};
    const message = messages[error.code];
    if (message) options.message = message;
    if (error.details) options.details = { ...error.details };
    return new ApiError(error.code, options);
  }
  if (error instanceof DocumentAccessDeniedError) return new ApiError(error.code);
  if (isGitError(error)) {
    if (error.code === "git.busy") return ApiError.rateLimited(2);
    if (error.code === "git.timeout") return ApiError.rateLimited(5);
    return ApiError.internal();
  }
  if (error instanceof markdown.MarkdownTooComplexError) {
    return new ApiError("document.edit_invalid", {
      message: messages["document.edit_invalid"] ?? "",
    });
  }
  return error;
}

/** Runs a handler body and maps its document failures. */
export async function documentCall<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    throw toDocumentApiError(error);
  }
}
