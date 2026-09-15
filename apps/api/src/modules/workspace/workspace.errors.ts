import { AccountKeyUnavailableError } from "@symplist/core/account";
import { PreferencesAccessError, PreferencesValidationError } from "@symplist/core/preferences";
import { ArchiveQueryError, TaskOperationError } from "@symplist/core/tasks";
import { ApiError } from "../../common/errors/api-error.ts";

/**
 * Maps a refused task or preference operation to the §6 envelope. Details carry only enums and
 * counters; unknown and foreign resources share `not_found`. Anything else is rethrown unchanged.
 */
export function toWorkspaceApiError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof TaskOperationError) {
    return new ApiError(error.code, error.details ? { details: { ...error.details } } : {});
  }
  if (error instanceof ArchiveQueryError) {
    return ApiError.validation([
      { path: [error.field], code: "invalid_value", message: "Invalid value" },
    ]);
  }
  if (error instanceof PreferencesValidationError) {
    return ApiError.validation(
      error.issues.map((issue) => ({
        path: [...issue.path].slice(0, 32),
        code: /^[a-z_]{1,64}$/.test(issue.code) ? issue.code : "custom",
        message: "Invalid value",
      })),
    );
  }
  if (error instanceof PreferencesAccessError) return new ApiError(error.code);
  // An account without a key is being deleted: nothing of it can be read or written.
  if (error instanceof AccountKeyUnavailableError) return ApiError.notFound();
  return error;
}

/** Runs `work` and converts refusals with {@link toWorkspaceApiError}. */
export async function workspaceCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toWorkspaceApiError(error);
  }
}
