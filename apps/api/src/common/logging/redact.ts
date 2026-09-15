/**
 * Log redaction (§6.3). Logs never carry bodies, OTPs, tokens, share keys, passwords, Vault
 * passphrases or values, prompts, document text, tool arguments or results, or email contents.
 *
 * Rather than trying to recognize secrets, the sanitizer only lets through values whose shape cannot
 * hold them: numbers, booleans, null, UUIDs, stable dotted codes, short identifiers and provider ids.
 * Every other string becomes `[redacted]`, and any field whose name suggests credentials or content
 * is redacted whatever its value.
 */

export const REDACTED = "[redacted]";

/** A value that may appear in a log line. */
export type LogValue =
  | string
  | number
  | boolean
  | null
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };

/** Fields passed with a log event. Values of any type are accepted and sanitized. */
export type LogFields = Readonly<Record<string, unknown>>;

const maxDepth = 3;
const maxArrayItems = 20;
const maxKeys = 40;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stableCodePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const identifierPattern = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** Plaintext provider correlation ids (§4.4): Composio connected accounts and Trigger runs. */
const providerIdPattern = /^(?:ca|run|batch|sched)_[A-Za-z0-9]{1,64}$/;
/** Route templates such as `/v1/tasks/:id`; never a query string. */
const routeTemplatePattern = /^\/[A-Za-z0-9_\-./:{}*]{0,200}$/;
const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Field names whose values are redacted unconditionally: credentials, secrets, personal data and
 * user-authored content. Matching is on the lower-cased name.
 */
const sensitiveNamePattern =
  /pass(?:word|phrase)?|secret|token|otp|pin|key|authoriz|bearer|cookie|csrf|nonce|signature|credential|prompt|body|text|content|markdown|document|message|argument|result|payload|email|address|recipient|subject|query|url|href|header|title|name|note|reason|value|preview|code/;

/** Names that look sensitive but always hold a value restricted to a safe shape. */
const shapeRestrictedNames: Readonly<Record<string, RegExp>> = {
  code: stableCodePattern,
  context: identifierPattern,
  errorcode: stableCodePattern,
  errorname: identifierPattern,
  reason: /^[a-z][a-z_]{0,31}$/,
  route: routeTemplatePattern,
};

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return !Object.hasOwn(shapeRestrictedNames, lower) && sensitiveNamePattern.test(lower);
}

function sanitizeString(name: string, value: string): string {
  const lower = name.toLowerCase();
  const restricted = Object.hasOwn(shapeRestrictedNames, lower)
    ? shapeRestrictedNames[lower]
    : null;
  if (restricted) return restricted.test(value) ? value : REDACTED;
  if (isSensitiveName(name)) return REDACTED;
  if (
    uuidPattern.test(value) ||
    stableCodePattern.test(value) ||
    identifierPattern.test(value) ||
    providerIdPattern.test(value)
  ) {
    return value;
  }
  return REDACTED;
}

function errorSummary(error: Error): LogValue {
  const summary: Record<string, LogValue> = {
    errorName: identifierPattern.test(error.name) ? error.name : "Error",
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && stableCodePattern.test(code)) summary.code = code;
  return summary;
}

function sanitizeValue(name: string, value: unknown, depth: number): LogValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "number":
      if (isSensitiveName(name)) return REDACTED;
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return isSensitiveName(name) ? REDACTED : Number(value);
    case "string":
      return sanitizeString(name, value);
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (value instanceof Error) return errorSummary(value);
  if (isSensitiveName(name)) return REDACTED;
  if (depth + 1 >= maxDepth) return REDACTED;
  if (Array.isArray(value)) {
    return value
      .slice(0, maxArrayItems)
      .map((item) => sanitizeValue(name, item, depth + 1) ?? null);
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED;
  return sanitizeRecord(value as Readonly<Record<string, unknown>>, depth + 1);
}

function sanitizeRecord(
  record: Readonly<Record<string, unknown>>,
  depth: number,
): Record<string, LogValue> {
  const output: Record<string, LogValue> = {};
  let count = 0;
  for (const [key, value] of Object.entries(record)) {
    if (!keyPattern.test(key)) continue;
    if (count >= maxKeys) break;
    const sanitized = sanitizeValue(key, value, depth);
    if (sanitized === undefined) continue;
    output[key] = sanitized;
    count += 1;
  }
  return output;
}

/** Sanitizes log fields for output; the result only holds values of safe shapes. */
export function sanitizeLogFields(fields: LogFields | undefined): Record<string, LogValue> {
  if (!fields) return {};
  return sanitizeRecord(fields, 0);
}

/** Whether an event name is a stable dotted code, as every log event must be. */
export function isLogEventName(value: string): boolean {
  return value.length <= 100 && stableCodePattern.test(value);
}

/**
 * Redacts every query parameter value of a request URL or path, including the share-route `key`
 * (§6.3), and any fragment. Parameter names that are plain identifiers survive, so only the shape of
 * the URL remains.
 */
export function redactUrl(url: string): string {
  const hashStart = url.indexOf("#");
  const withoutFragment = hashStart === -1 ? url : url.slice(0, hashStart);
  const queryStart = withoutFragment.indexOf("?");
  if (queryStart === -1) return withoutFragment;
  const path = withoutFragment.slice(0, queryStart);
  const parts = withoutFragment
    .slice(queryStart + 1)
    .split("&")
    .filter((part) => part.length > 0)
    .map((part) => {
      const equals = part.indexOf("=");
      const rawName = equals === -1 ? part : part.slice(0, equals);
      let name = REDACTED;
      try {
        const decoded = decodeURIComponent(rawName.replaceAll("+", " "));
        if (keyPattern.test(decoded)) name = decoded;
      } catch {
        // A malformed escape keeps the redacted name.
      }
      return equals === -1 ? name : `${name}=${REDACTED}`;
    });
  return parts.length === 0 ? path : `${path}?${parts.join("&")}`;
}
