/**
 * Error mapping for worker code (§8.3). Errors from providers, Composio, D1, R2, Git and the AI SDK are
 * mapped to a stable code before they are thrown, so Trigger's run error records hold nothing but the
 * code: the message is the code, and no cause, response body, SQL, path or argument is kept.
 */

const stableCode = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export class WorkerError extends Error {
  readonly code: string;
  /** Whether retrying the same operation later can succeed. */
  readonly retryable: boolean;

  constructor(code: string, retryable = false) {
    const safe = stableCode.test(code) && code.length <= 64 ? code : "internal.error";
    super(safe);
    this.name = "WorkerError";
    this.code = safe;
    this.retryable = retryable;
  }
}

function record(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : undefined;
}

const retryableCodes = new Set([
  "rate.limited",
  "db.unavailable",
  "db.unknown_outcome",
  "storage.unavailable",
  "storage.rate_limited",
  "network.unavailable",
  "integration.unavailable",
  "integration.rate_limited",
  "ai.unavailable",
  "trigger.unavailable",
  "account_purge.incomplete",
]);

function mapped(code: string): WorkerError {
  return new WorkerError(code, retryableCodes.has(code));
}

function httpFamily(prefix: "integration" | "trigger", status: unknown): WorkerError {
  if (status === 429) return mapped(`${prefix}.rate_limited`);
  if (typeof status === "number" && status >= 400 && status < 500)
    return mapped(`${prefix}.rejected`);
  return mapped(`${prefix}.unavailable`);
}

/** Maps any thrown value to a `WorkerError` carrying only a stable code. */
export function toWorkerError(error: unknown): WorkerError {
  if (error instanceof WorkerError) return error;
  const value = record(error);
  const name = typeof value?.name === "string" ? value.name : "";
  const code = value?.code;

  // Symplist packages (db, storage, crypto, email, config) throw errors with stable dotted codes.
  if (typeof code === "string" && stableCode.test(code) && code.length <= 64) return mapped(code);
  if (name === "ConfigError") return mapped("config.invalid");

  if (name === "AbortError" || name === "LocalExecutionAborted" || name === "TimeoutError") {
    return mapped("run.aborted");
  }
  // AI SDK errors are named AI_<Kind>Error (APICallError, RetryError, NoSuchModelError, …).
  if (name.startsWith("AI_")) return mapped("ai.unavailable");
  // Composio core errors and raw client API errors, detected by shape (§14.1).
  if (name.startsWith("Composio") || (value && "requestId" in value && "status" in value)) {
    return httpFamily("integration", value?.status);
  }
  // Trigger.dev SDK ApiError subclasses.
  if (
    /^(Api|Authentication|BadRequest|Conflict|InternalServer|NotFound|PermissionDenied|RateLimit|UnprocessableEntity)Error$/.test(
      name,
    )
  ) {
    return httpFamily("trigger", value?.status);
  }
  // child_process failures (Git): a numeric exit code or a spawn errno, with the command attached.
  if (value && ("cmd" in value || "spawnargs" in value)) return mapped("git.failed");
  if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code)) {
    return mapped(
      code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT"
        ? "network.unavailable"
        : "system.io_failed",
    );
  }
  if (name === "TypeError" && value && "cause" in value) return mapped("network.unavailable");
  return mapped("internal.error");
}

/** Runs `operation` and rethrows any failure as a mapped `WorkerError`. */
export async function withMappedErrors<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throw toWorkerError(error);
  }
}
