/**
 * Git failures carry only a stable code, the Git subcommand and the exit status: never stderr,
 * arguments, paths or object contents, so logs, Trigger error records and responses stay free of
 * document text (§6.3, §8.3).
 */
export type GitErrorCode =
  /** The Git executable is missing or could not be started. */
  | "git.unavailable"
  /** A command exited with a failure status. */
  | "git.failed"
  /** A command ran longer than its time limit and was killed. */
  | "git.timeout"
  /** A command's output exceeded its byte limit and was killed. */
  | "git.output_too_large"
  /** A bundle or repository failed an integrity or shape check. */
  | "git.integrity_failed"
  /** Every reconstruction slot is busy and the queue is full. */
  | "git.busy"
  /** An operation input broke a limit before Git ran (document, bundle or history size). */
  | "git.limit_exceeded";

export class GitError extends Error {
  readonly code: GitErrorCode;
  /** The Git subcommand (`bundle`, `fsck`, …) when a command failed. */
  readonly subcommand: string | undefined;
  readonly exitCode: number | undefined;

  constructor(
    code: GitErrorCode,
    options: { readonly subcommand?: string; readonly exitCode?: number } = {},
  ) {
    super(code);
    this.name = "GitError";
    this.code = code;
    this.subcommand = options.subcommand;
    this.exitCode = options.exitCode;
  }

  /** Whether retrying the same operation later can succeed. */
  get retryable(): boolean {
    return this.code === "git.busy" || this.code === "git.timeout";
  }
}

export function isGitError(value: unknown, code?: GitErrorCode): value is GitError {
  return value instanceof GitError && (code === undefined || value.code === code);
}
