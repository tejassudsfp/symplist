/**
 * Stable data-access error codes. Messages never contain SQL text, parameter values or provider
 * response bodies, so errors can be logged by name and code (§6.3, §8.3).
 */
export type DbErrorCode =
  /** The request budget refused the call: circuit open, lane shed or queue wait too long (§3.1). */
  | "rate.limited"
  /** A statement or batch breaks a D1 limit before anything is sent (§3.2). */
  | "db.limit_exceeded"
  /** A statement is malformed: several statements, transaction control, bad placeholders. */
  | "db.invalid_statement"
  /** An `UPDATE`, `DELETE` or `REPLACE` targeted an append-only table (§5.6). */
  | "db.append_only"
  /** D1 or SQLite executed the batch and reported a failure; the batch did not commit. */
  | "db.statement_failed"
  /** A write was sent but its outcome is unknown; reconcile by write id or request id (§3.1). */
  | "db.unknown_outcome"
  /** A read could not be completed (network failure, timeout, 5xx, retryable D1 message). */
  | "db.unavailable"
  /** D1 rejected the credential (HTTP 401 or 403). */
  | "db.unauthorized"
  /** D1 rejected the request for another reason, for example an unknown database (HTTP 404). */
  | "db.request_rejected"
  /** The caller aborted before the request was sent. */
  | "db.aborted"
  /** A local development adapter was started with `NODE_ENV=production` (decision A7). */
  | "db.production_refused"
  /** A migration file is malformed or failed to apply (§3.4). */
  | "db.migration_failed"
  /** Migration CLI configuration is missing or invalid. */
  | "db.config_invalid";

/** Classification of a statement failure, derived from the SQLite or D1 message text. */
export type DbFailureKind =
  | "constraint"
  | "type"
  | "append_only"
  | "syntax"
  | "authorization"
  | "other";

/** The constraint that failed when `kind` is `constraint`. */
export type DbConstraint =
  | "unique"
  | "primary_key"
  | "check"
  | "not_null"
  | "foreign_key"
  | "trigger";

export interface DbErrorOptions {
  /** A diagnostic message from SQLite or D1, kept off enumerable properties and out of `message`. */
  readonly providerMessage?: string;
}

/** Base class for every data-access error. */
export class DbError extends Error {
  readonly code: DbErrorCode;
  declare readonly providerMessage: string | undefined;

  constructor(code: DbErrorCode, message: string, options: DbErrorOptions = {}) {
    super(message);
    this.name = "DbError";
    this.code = code;
    // Provider text can quote SQL fragments or constraint names; it is readable by code that needs
    // it (tests, the fake D1 API) but never serialized by JSON.stringify or default inspectors.
    Object.defineProperty(this, "providerMessage", {
      value: options.providerMessage,
      enumerable: false,
      writable: false,
    });
  }
}

export type RateLimitedReason =
  /** A previous HTTP 429 or an exhausted `Ratelimit` header opened the process-wide circuit. */
  | "circuit_open"
  /** Unauthenticated work was shed because its share of the lane bucket is exhausted. */
  | "shed"
  /** The lane queue would make the caller wait longer than the lane allows. */
  | "queue_timeout"
  /** D1 answered HTTP 429. */
  | "http_429";

/** `rate.limited`: the api returns 503 with `retryAfter` (§3.1). */
export class DbRateLimitedError extends DbError {
  readonly reason: RateLimitedReason;
  readonly retryAfterMs: number;

  constructor(reason: RateLimitedReason, retryAfterMs: number) {
    super("rate.limited", `D1 request refused by the request budget (${reason})`);
    this.name = "DbRateLimitedError";
    this.reason = reason;
    this.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
  }

  /** Whole seconds for a `Retry-After` header or a `retryAfter` response field. */
  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.retryAfterMs / 1000));
  }
}

export type DbLimit = "params" | "sql_bytes" | "value_bytes" | "batch_empty" | "statement_empty";

/** `db.limit_exceeded`: rejected before sending (§3.2). */
export class DbLimitError extends DbError {
  readonly limit: DbLimit;
  readonly statementIndex: number | undefined;

  constructor(limit: DbLimit, statementIndex?: number) {
    super("db.limit_exceeded", `Statement exceeds the D1 ${limit} limit${at(statementIndex)}`);
    this.name = "DbLimitError";
    this.limit = limit;
    this.statementIndex = statementIndex;
  }
}

/** `db.invalid_statement` or `db.append_only`: rejected before sending. */
export class DbInvalidStatementError extends DbError {
  readonly statementIndex: number | undefined;

  constructor(
    code: "db.invalid_statement" | "db.append_only",
    detail: string,
    statementIndex?: number,
  ) {
    super(code, `${detail}${at(statementIndex)}`);
    this.name = "DbInvalidStatementError";
    this.statementIndex = statementIndex;
  }
}

export interface DbStatementErrorInit {
  readonly providerMessage: string;
  /** The failing statement when the provider identifies it. */
  readonly statementIndex?: number;
  /** HTTP status of the REST response (400, or 200 with `success: false`); absent locally. */
  readonly httpStatus?: number;
}

/** `db.statement_failed`: the batch executed and failed as a whole (§3.2). */
export class DbStatementError extends DbError {
  readonly kind: DbFailureKind;
  readonly constraint: DbConstraint | undefined;
  readonly statementIndex: number | undefined;
  readonly httpStatus: number | undefined;

  constructor(init: DbStatementErrorInit) {
    const { kind, constraint } = classifyFailure(init.providerMessage);
    super(
      "db.statement_failed",
      `D1 batch failed (${constraint ?? kind})${at(init.statementIndex)}`,
      { providerMessage: init.providerMessage },
    );
    this.name = "DbStatementError";
    this.kind = kind;
    this.constraint = constraint;
    this.statementIndex = init.statementIndex;
    this.httpStatus = init.httpStatus;
  }
}

export type UnknownOutcomeCause =
  | "network"
  | "timeout"
  | "aborted"
  | "server_error"
  | "bad_response";

/** `db.unknown_outcome`: a write may or may not have committed; writes are never retried (§3.1). */
export class DbUnknownOutcomeError extends DbError {
  readonly failure: UnknownOutcomeCause;

  constructor(cause: UnknownOutcomeCause, providerMessage?: string) {
    super("db.unknown_outcome", `D1 write outcome unknown (${cause})`, { providerMessage });
    this.name = "DbUnknownOutcomeError";
    this.failure = cause;
  }
}

/** `db.unavailable`: a read failed after its retries. */
export class DbUnavailableError extends DbError {
  readonly failure: UnknownOutcomeCause;

  constructor(cause: UnknownOutcomeCause, providerMessage?: string) {
    super("db.unavailable", `D1 read unavailable (${cause})`, { providerMessage });
    this.name = "DbUnavailableError";
    this.failure = cause;
  }
}

/** Whether a value is a data-access error, optionally with a specific code. */
export function isDbError(value: unknown, code?: DbErrorCode): value is DbError {
  return value instanceof DbError && (code === undefined || value.code === code);
}

function at(statementIndex: number | undefined): string {
  return statementIndex === undefined ? "" : ` at statement ${statementIndex}`;
}

/** Marker used by append-only triggers: `RAISE(ABORT, 'append_only: <table>')`. */
export const APPEND_ONLY_MESSAGE_PREFIX = "append_only:";

/** Classifies SQLite and D1 failure text, which share SQLite's wording. */
export function classifyFailure(message: string): {
  kind: DbFailureKind;
  constraint: DbConstraint | undefined;
} {
  const text = message.toLowerCase();
  if (text.includes(APPEND_ONLY_MESSAGE_PREFIX)) {
    return { kind: "append_only", constraint: "trigger" };
  }
  if (text.includes("unique constraint failed"))
    return { kind: "constraint", constraint: "unique" };
  if (text.includes("primary key constraint failed")) {
    return { kind: "constraint", constraint: "primary_key" };
  }
  if (text.includes("check constraint failed")) return { kind: "constraint", constraint: "check" };
  if (text.includes("not null constraint failed")) {
    return { kind: "constraint", constraint: "not_null" };
  }
  if (text.includes("foreign key constraint failed")) {
    return { kind: "constraint", constraint: "foreign_key" };
  }
  if (text.includes("cannot store") && text.includes("column")) {
    return { kind: "type", constraint: undefined };
  }
  if (text.includes("not authorized")) return { kind: "authorization", constraint: undefined };
  if (
    text.includes("syntax error") ||
    text.includes("no such") ||
    text.includes("incomplete input")
  ) {
    return { kind: "syntax", constraint: undefined };
  }
  return { kind: "other", constraint: undefined };
}
