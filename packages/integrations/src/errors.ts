export type IntegrationCode =
  | "integration.unavailable"
  | "integration.unauthorized"
  | "integration.rate_limited"
  | "integration.provider_failed"
  | "integration.uncertain"
  | "integration.invalid_response"
  | "integration.tool_unavailable"
  | "integration.invalid_arguments"
  | "integration.account_selection_required"
  | "integration.connection_required";

/** No provider message, cause, body, arguments or headers escape this boundary. */
export class IntegrationError extends Error {
  override readonly name = "IntegrationError";
  constructor(
    readonly code: IntegrationCode,
    readonly details: Readonly<{
      status?: number;
      slug?: string;
      requestId?: string;
      retryAfter?: number;
      /** Native ids only, never provider account ids or credential-bearing labels. */
      choices?: readonly { readonly id: string; readonly toolkit: string }[];
    }> = {},
  ) {
    super(code);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_:.-]{0,127}$/.test(value)
    ? value
    : undefined;
}

export function normalizeIntegrationError(error: unknown, sideEffect = false): IntegrationError {
  if (error instanceof IntegrationError) return error;
  const object = record(error);
  const cause = record(object.cause);
  const statusValue = object.status ?? object.statusCode ?? cause.status;
  const status =
    typeof statusValue === "number" && statusValue >= 400 && statusValue <= 599
      ? statusValue
      : undefined;
  const body = record(object.error ?? cause.error);
  const nested = record(body.error);
  const headers = object.headers ?? cause.headers;
  const retry =
    headers instanceof Headers ? headers.get("retry-after") : record(headers)["retry-after"];
  const seconds =
    typeof retry === "string" && /^\d+$/.test(retry)
      ? Number(retry)
      : typeof retry === "string" && Number.isFinite(Date.parse(retry))
        ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
        : 60;
  const details = {
    ...(status === undefined ? {} : { status }),
    ...(safeId(body.slug ?? nested.slug) ? { slug: safeId(body.slug ?? nested.slug) } : {}),
    ...(safeId(body.request_id ?? nested.request_id)
      ? { requestId: safeId(body.request_id ?? nested.request_id) }
      : {}),
    ...(status === 429 ? { retryAfter: Math.max(1, Math.min(seconds, 86400)) } : {}),
  };
  if (status === 429) return new IntegrationError("integration.rate_limited", details);
  if (status === 401 || status === 403)
    return new IntegrationError("integration.unauthorized", details);
  return new IntegrationError(
    sideEffect ? "integration.uncertain" : "integration.provider_failed",
    details,
  );
}
