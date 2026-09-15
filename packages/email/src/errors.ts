/**
 * Stable error codes raised by the email package. Messages never contain addresses, subjects,
 * bodies, OTPs, provider messages or credentials (§6.3), so errors are safe to log by name and code.
 */
export const emailErrorCodes = [
  "email.invalid_message",
  "email.invalid_template_input",
  "email.not_configured",
  "email.driver_refused",
  "email.unauthorized",
  "email.rejected",
  "email.idempotency_conflict",
  "email.idempotency_in_flight",
  "email.rate_limited",
  "email.quota_exceeded",
  "email.provider_unavailable",
  "email.network_error",
  "email.invalid_response",
] as const;

export type EmailErrorCode = (typeof emailErrorCodes)[number];

export interface EmailErrorDetails {
  /** HTTP status from the provider, when there was a response. */
  readonly status?: number;
  /** The provider's enumerated error name (for example `rate_limit_exceeded`), never its message. */
  readonly providerErrorName?: string;
  /** Whether sending the same message again with the same idempotency key may succeed. */
  readonly retryable?: boolean;
  /** Seconds to wait before retrying, from `Retry-After` when the provider sent one. */
  readonly retryAfterSeconds?: number;
}

export class EmailError extends Error {
  override readonly name: string = "EmailError";
  readonly code: EmailErrorCode;
  readonly status: number | undefined;
  readonly providerErrorName: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: EmailErrorCode, message: string, details: EmailErrorDetails = {}) {
    super(message);
    this.code = code;
    this.status = details.status;
    this.providerErrorName = details.providerErrorName;
    this.retryable = details.retryable ?? false;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/** A message or template input that cannot be sent; fix the caller, never retry. */
export class EmailValidationError extends EmailError {
  override readonly name = "EmailValidationError";
}

/** Transport or sender configuration that is missing or forbidden in this environment. */
export class EmailConfigurationError extends EmailError {
  override readonly name = "EmailConfigurationError";
}

/** The provider refused or failed a send. `retryable` and `retryAfterSeconds` guide the outbox. */
export class EmailSendError extends EmailError {
  override readonly name = "EmailSendError";
}
