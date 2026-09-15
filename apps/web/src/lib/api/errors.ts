import { type ErrorCode, errorEnvelopeSchema } from "@symplist/contracts";

/** A stable error code from the contracts, or a code this client build does not know yet. */
export type ApiErrorCode = ErrorCode | (string & {});

/** Base class for every failure the browser API client reports. */
export abstract class ApiClientError extends Error {
  abstract readonly kind:
    | "api"
    | "network"
    | "protocol"
    | "aborted"
    | "configuration"
    | "server_side";
}

/** The API answered with its error envelope (§6). */
export class ApiError extends ApiClientError {
  readonly kind = "api" as const;
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly requestId: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  /** Seconds to wait before retrying, from `details.retryAfter` or the `Retry-After` header. */
  readonly retryAfterSeconds: number | undefined;

  constructor(init: {
    status: number;
    code: ApiErrorCode;
    message: string;
    requestId: string;
    details?: Readonly<Record<string, unknown>>;
    retryAfterSeconds?: number;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }

  /** Type guard for a specific stable code, for example `task.archived`. */
  is<Code extends ApiErrorCode>(code: Code): this is ApiError & { code: Code } {
    return this.code === code;
  }
}

/** The request never produced a response (offline, DNS, CORS rejection, connection reset). */
export class ApiNetworkError extends ApiClientError {
  readonly kind = "network" as const;
  constructor(options?: { cause?: unknown }) {
    super("The request could not reach Symplist", options);
    this.name = "ApiNetworkError";
  }
}

/** The response did not match the protocol: a non-JSON error body or a body that failed its schema. */
export class ApiProtocolError extends ApiClientError {
  readonly kind = "protocol" as const;
  readonly status: number;
  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiProtocolError";
    this.status = status;
  }
}

/** The caller aborted the request. */
export class ApiAbortedError extends ApiClientError {
  readonly kind = "aborted" as const;
  constructor() {
    super("The request was cancelled");
    this.name = "ApiAbortedError";
  }
}

/** Public configuration (the API origin) is missing or invalid in this build. */
export class ApiConfigurationError extends ApiClientError {
  readonly kind = "configuration" as const;
  constructor(message: string) {
    super(message);
    this.name = "ApiConfigurationError";
  }
}

/** The client was used outside a browser. The web app never calls the API from server code (§5.1). */
export class ServerSideApiCallError extends ApiClientError {
  readonly kind = "server_side" as const;
  constructor() {
    super("The Symplist API client runs only in the browser; server code must not call the API");
    this.name = "ServerSideApiCallError";
  }
}

export function isApiError(error: unknown, code?: ApiErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

function retryAfterFrom(details: Record<string, unknown> | undefined, header: string | null) {
  const fromDetails = details?.retryAfter;
  if (typeof fromDetails === "number" && Number.isFinite(fromDetails) && fromDetails >= 0) {
    return fromDetails;
  }
  if (header !== null && /^\d+$/.test(header.trim())) return Number(header.trim());
  return undefined;
}

/** Parses a non-2xx response into a typed error; never throws while parsing. */
export async function errorFromResponse(response: Response): Promise<ApiError | ApiProtocolError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    return new ApiProtocolError(response.status, `Unexpected ${response.status} response`, {
      cause,
    });
  }
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return new ApiProtocolError(response.status, `Unexpected ${response.status} response`, {
      cause: parsed.error,
    });
  }
  const { code, message, details, requestId } = parsed.data.error;
  const retryAfterSeconds = retryAfterFrom(details, response.headers.get("retry-after"));
  return new ApiError({
    status: response.status,
    code,
    message,
    requestId,
    ...(details ? { details } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}
