import { z } from "zod";
import type { ConfigIssue } from "./errors.ts";

/**
 * Zod field schemas for environment variables. Browser-safe: no `node:*` imports. Every schema sets
 * its own messages, and no message includes the input, so a validation report never echoes a value.
 */

/** An environment as provided by `process.env`, an env file parser or a test. */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * The variables that have a value. An empty value (`KEY=` in an env file) counts as unset, so
 * `.env.example` files can list every variable without configuring it.
 */
export function presentVariables(env: EnvRecord): Record<string, string> {
  const present: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value !== "") present[name] = value;
  }
  return present;
}

/** Zod accepts any object shape; this validates that the input is an environment record. */
export const envRecordSchema = z.custom<EnvRecord>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => entry === undefined || typeof entry === "string"),
  { error: "The environment must be a record of string values" },
);

const requiredMessage = "is required";

function text(invalid: string) {
  return z.string({ error: (issue) => (issue.input === undefined ? requiredMessage : invalid) });
}

/** A required value matching `pattern`. */
export function patternVariable(pattern: RegExp, invalid: string) {
  return text(invalid).regex(pattern, { error: invalid });
}

/** An optional value matching `pattern`. */
export function optionalPatternVariable(pattern: RegExp, invalid: string) {
  return patternVariable(pattern, invalid).optional();
}

/** A strict boolean: exactly `true` or `false`; absent means `defaultValue`. */
export function booleanVariable(defaultValue: boolean) {
  return z
    .enum(["true", "false"], { error: 'must be "true" or "false"' })
    .optional()
    .transform((value) => (value === undefined ? defaultValue : value === "true"));
}

/**
 * A feature flag for a deferred module: absent or `false`; `true` is rejected at startup (§16.1).
 */
export function disabledFlagVariable(feature: string) {
  return z
    .enum(["true", "false"], { error: 'must be "true" or "false"' })
    .optional()
    .refine((value) => value !== "true", {
      error: `must be false: ${feature} is not available in this release`,
    })
    .transform((): false => false);
}

interface IntegerOptions {
  readonly min: number;
  readonly max: number;
}

function integerSchema({ min, max }: IntegerOptions) {
  const invalid = `must be a whole number from ${min} to ${max}`;
  return text(invalid)
    .regex(/^(?:0|[1-9][0-9]{0,14})$/, { error: invalid })
    .transform(Number)
    .pipe(z.number().min(min, { error: invalid }).max(max, { error: invalid }));
}

/** A required whole number in `[min, max]`, written in canonical decimal form. */
export function integerVariable(options: IntegerOptions) {
  return integerSchema(options);
}

/** An optional whole number in `[min, max]`; absent means `defaultValue`. */
export function integerWithDefaultVariable(options: IntegerOptions & { readonly default: number }) {
  return integerSchema(options)
    .optional()
    .transform((value) => value ?? options.default);
}

/** An optional whole number in `[min, max]` without a default. */
export function optionalIntegerVariable(options: IntegerOptions) {
  return integerSchema(options).optional();
}

/** A required value from `values`. */
export function enumVariable<const Values extends readonly [string, ...string[]]>(values: Values) {
  return z.enum(values, {
    error: (issue) =>
      issue.input === undefined ? requiredMessage : `must be one of: ${values.join(", ")}`,
  });
}

/** An optional value from `values`; absent means `defaultValue`. */
export function enumWithDefaultVariable<const Values extends readonly [string, ...string[]]>(
  values: Values,
  defaultValue: Values[number],
) {
  return z
    .enum(values, { error: `must be one of: ${values.join(", ")}` })
    .optional()
    .transform((value): Values[number] => value ?? defaultValue);
}

/** A fixed literal value that must be present. */
export function literalVariable<const Value extends string>(value: Value) {
  return z.literal(value, {
    error: (issue) => (issue.input === undefined ? requiredMessage : `must be ${value}`),
  });
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a hostname (as `URL.hostname` reports it) is a loopback host. */
export function isLoopbackHostname(hostname: string): boolean {
  return loopbackHosts.has(hostname);
}

type OriginKind = "http" | "ws";

const schemesByKind: Readonly<Record<OriginKind, readonly [insecure: string, secure: string]>> = {
  http: ["http:", "https:"],
  ws: ["ws:", "wss:"],
};

/**
 * Parses a canonical origin (`scheme://host[:port]` with no path, query, credentials, trailing
 * slash, uppercase host or default port) of the given kind, or returns null.
 */
export function parseOrigin(value: string, kind: OriginKind): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!schemesByKind[kind].includes(url.protocol)) return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin === value ? url : null;
}

/** Whether an origin uses the secure scheme of its kind (`https:` or `wss:`). */
export function isSecureOrigin(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "wss:";
}

function originSchema(kind: OriginKind) {
  const example = kind === "http" ? "https://host[:port]" : "wss://host[:port]";
  const invalid = `must be an origin such as ${example}, without a path or trailing slash`;
  return text(invalid).refine((value) => parseOrigin(value, kind) !== null, { error: invalid });
}

/** A required http(s) or ws(s) origin. */
export function originVariable(kind: OriginKind) {
  return originSchema(kind);
}

/** An optional http(s) or ws(s) origin. */
export function optionalOriginVariable(kind: OriginKind) {
  return originSchema(kind).optional();
}

/**
 * An optional provider credential: one line of printable ASCII without spaces, 8 to 4096
 * characters. Surrounding whitespace, quotes left in by copy and paste and line breaks are rejected.
 */
export function credentialVariable() {
  const invalid =
    "must be a single-line credential of 8 to 4096 printable characters without spaces";
  return z
    .string({ error: invalid })
    .regex(/^[\x21-\x7e]{8,4096}$/, { error: invalid })
    .refine((value) => !/^["'].*["']$/.test(value), { error: invalid })
    .optional();
}

/** An optional JSON object, for example service-account credentials. */
export function jsonObjectVariable() {
  const invalid = "must be a JSON object of at most 16384 characters";
  return z
    .string({ error: invalid })
    .max(16_384, { error: invalid })
    .refine(
      (value) => {
        try {
          const parsed: unknown = JSON.parse(value);
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
        } catch {
          return false;
        }
      },
      { error: invalid },
    )
    .optional();
}

const emailSchema = z.email();

/** Whether a value is a plain email address. */
export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && emailSchema.safeParse(value).success;
}

/** Whether a value is an email address or `Display Name <address>`. */
export function isMailbox(value: string): boolean {
  const named = /^([^<>"\r\n\t]{1,100}?) <([^<>\s]+)>$/.exec(value);
  if (named) {
    const [, name, address] = named;
    return (
      name !== undefined && name.trim() === name && address !== undefined && isEmailAddress(address)
    );
  }
  return isEmailAddress(value);
}

function mailboxSchema() {
  const invalid = "must be an email address or Display Name <address>";
  return text(invalid).refine(isMailbox, { error: invalid });
}

/** A required sender mailbox. */
export function mailboxVariable() {
  return mailboxSchema();
}

/** An optional sender mailbox. */
export function optionalMailboxVariable() {
  return mailboxSchema().optional();
}

/** An optional email address, normalized to trimmed lowercase. */
export function optionalEmailVariable() {
  const invalid = "must be an email address";
  return z
    .string({ error: invalid })
    .transform((value) => value.trim().toLowerCase())
    .refine(isEmailAddress, { error: invalid })
    .optional();
}

/** Whether a value names an IANA time zone known to this runtime. Offsets such as `+05:30` are not zones. */
export function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** An optional IANA time zone; absent means `defaultValue`. */
export function timeZoneVariable(defaultValue: string) {
  const invalid = "must be an IANA time zone such as UTC or Asia/Kolkata";
  return z
    .string({ error: invalid })
    .refine(isTimeZone, { error: invalid })
    .optional()
    .transform((value) => value ?? defaultValue);
}

/** Converts Zod issues from an object schema into configuration issues keyed by variable. */
export function issuesFromZod(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    variable: typeof issue.path[0] === "string" ? issue.path[0] : "(environment)",
    message: issue.message,
  }));
}

/** The per-parse fallback message for any issue a field schema did not describe itself. */
export const fallbackIssueMessage = (): string => "is invalid";
