import {
  type ErrorBody,
  type ErrorCode,
  type ErrorEnvelope,
  errorHttpStatus,
  isErrorCode,
  retryAfterHeader,
  type ValidationIssue,
} from "@symplist/contracts";
import type { Response } from "express";

/** Safe, fixed texts for the platform's codes. Messages never carry names, values or internals. */
const platformMessages: Partial<Record<ErrorCode, string>> = {
  not_found: "Not found",
  validation: "The request is invalid",
  internal: "Something went wrong",
  "request.too_large": "The request is too large",
  "auth.session_required": "Sign in to continue",
  "auth.origin_forbidden": "This origin is not allowed",
  "auth.csrf_invalid": "The request could not be verified",
  "access.unverified": "Verify your email to continue",
  "access.locked": "This account is not admitted yet",
  "access.relocked": "Access to this account was paused",
  "access.suspended": "This account is suspended",
  "access.admin_required": "Administrator access is required",
  "idempotency.key_required": "An Idempotency-Key header is required",
  "idempotency.key_invalid": "The Idempotency-Key header is invalid",
  "idempotency.mismatch": "The Idempotency-Key was used with a different request",
  "idempotency.in_progress": "The original request is still in progress",
  "rate.limited": "Too many requests; try again later",
};

function defaultMessage(code: ErrorCode, status: number): string {
  return platformMessages[code] ?? (status >= 500 ? "Something went wrong" : "The request failed");
}

export interface ApiErrorOptions {
  readonly message?: string;
  /** Structured, non-secret details (never user content or identifiers of other users). */
  readonly details?: Record<string, unknown>;
  /** Seconds for `Retry-After`; required for `rate.limited`. */
  readonly retryAfter?: number;
}

/**
 * An error returned to the client as the §6 envelope. Throw it from guards, interceptors, services
 * and handlers; the global filter adds the request id.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfter: number | undefined;

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    if (!isErrorCode(code)) throw new TypeError("Unknown error code");
    const status = errorHttpStatus(code);
    super(options.message ?? defaultMessage(code, status));
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryAfter =
      options.retryAfter === undefined
        ? undefined
        : Math.min(86_400, Math.max(1, Math.ceil(options.retryAfter)));
    this.details =
      code === "rate.limited"
        ? { ...options.details, retryAfter: this.retryAfter ?? 1 }
        : options.details;
  }

  /** Unknown and unauthorized resources share this exact shape, without names (§6). */
  static notFound(): ApiError {
    return new ApiError("not_found");
  }

  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError("rate.limited", { retryAfter: retryAfterSeconds });
  }

  static validation(issues: readonly ValidationIssue[]): ApiError {
    return new ApiError("validation", { details: { issues: issues.slice(0, 100) } });
  }

  static internal(): ApiError {
    return new ApiError("internal");
  }

  /** The envelope body for a request id. */
  toEnvelope(requestId: string): ErrorEnvelope {
    const error: ErrorBody = { code: this.code, message: this.message, requestId };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

/** Writes an error envelope directly, for middleware that runs before Nest's exception layer. */
export function sendApiError(res: Response, error: ApiError, requestId: string): void {
  if (res.headersSent) return;
  res.status(error.status);
  res.setHeader("Cache-Control", "no-store");
  if (error.code === "rate.limited") res.setHeader(retryAfterHeader, String(error.retryAfter ?? 1));
  res.json(error.toEnvelope(requestId));
}
