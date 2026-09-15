import type { AccessDenialCode } from "../access/evaluate.ts";

/** Stable codes a task or preference operation fails with; each is a declared contracts error code. */
export type TaskErrorCode =
  | "not_found"
  | "task.archived"
  | "task.run_active"
  | "task.conflict"
  | "task.placement_invalid"
  | "task.depth_limit"
  | AccessDenialCode;

/**
 * A refused task operation. Nothing was applied. `details` holds only enums and counters, never
 * titles or other user content.
 */
export class TaskOperationError extends Error {
  readonly code: TaskErrorCode;
  readonly details: Readonly<Record<string, string | number>> | undefined;

  constructor(code: TaskErrorCode, details?: Readonly<Record<string, string | number>>) {
    super(`Task operation refused: ${code}`);
    this.name = "TaskOperationError";
    this.code = code;
    this.details = details;
  }
}

export function isTaskOperationError(error: unknown): error is TaskOperationError {
  return error instanceof TaskOperationError;
}
