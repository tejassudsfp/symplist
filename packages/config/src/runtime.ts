import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as z from "zod";
import { type ConfigIssue, type ConfigResult, normalizeIssues } from "./errors.ts";
import {
  booleanVariable,
  credentialVariable,
  disabledFlagVariable,
  type EnvRecord,
  enumVariable,
  enumWithDefaultVariable,
  fallbackIssueMessage,
  integerWithDefaultVariable,
  isLoopbackHostname,
  isSecureOrigin,
  issuesFromZod,
  optionalOriginVariable,
  optionalPatternVariable,
  originVariable,
  parseOrigin,
  posthogProjectKeyVariable,
  presentVariables,
  timeZoneVariable,
} from "./fields.ts";
import { defaultLocalDataDir, isValidLocalDataDir } from "./local-data.ts";
import {
  duplicateSecretIssues,
  type GeneratedSecretFamily,
  type ParsedSecretFamily,
  parseSecretFamilies,
  presentSecretEntries,
  rejectedSecretIssues,
  type SecretRuntime,
  secretFamiliesFor,
} from "./secrets.ts";
import type { NodeEnv, SecretFamilyConfig } from "./shared.ts";

/**
 * Schemas and cross-field rules shared by the api and the worker (§16.1, §16.2). Node-only.
 */

export const nodeEnvs = ["development", "test", "production"] as const satisfies readonly NodeEnv[];

/** The largest document body: 1 MiB, so an encrypted draft stays within D1's 2 MB value limit (§3.2). */
export const docMaxBytesLimit = 1_048_576;

function gitTmpDirVariable() {
  const invalid = "must be an absolute directory path";
  return z
    .string({ error: invalid })
    .refine((value) => isAbsolute(value) && !value.includes("\u0000"), { error: invalid })
    .optional()
    .transform((value) => value ?? join(tmpdir(), "symplist-git"));
}

/**
 * `LOCAL_DATA_DIR`: the absolute directory holding the local D1 and R2 stand-ins, shared by the api and
 * `trigger dev`. Unset, it resolves to `<repo>/.local-data` (see `defaultLocalDataDir`).
 */
function localDataDirVariable() {
  const invalid = "must be an absolute directory path";
  return z
    .string({ error: invalid })
    .refine(isValidLocalDataDir, { error: invalid })
    .optional()
    .transform((value) => value ?? defaultLocalDataDir());
}

/**
 * `TRIGGER_SECRET_KEY`: a Trigger.dev environment secret key (`tr_dev_…`, `tr_prod_…`). A personal
 * access token (`tr_pat_…`, the CI-only `TRIGGER_ACCESS_TOKEN`) is refused, so the deploy credential
 * can never be held by the api or the worker under another name (§4.5).
 */
export function triggerSecretKeyVariable() {
  return optionalPatternVariable(
    /^tr_(?!pat_)[A-Za-z0-9_]{8,256}$/,
    "must be a Trigger.dev environment secret key (tr_…), not a personal access token",
  );
}

/** Variables read by both runtimes ("both" in §16.2), with their defaults. */
export const sharedVariableShape = {
  WEB_ORIGIN: originVariable("http"),
  API_ORIGIN: originVariable("http"),
  WS_ORIGIN: originVariable("ws"),

  /**
   * Which deployment this is, and it changes what the rest of the rules mean.
   *
   * `cloud` is the hosted service and every self-hosted instance of it: D1, R2, Resend, real origins,
   * accounts behind OTP and an invite. `local` is one person's own machine — the Symplist desktop app
   * in offline mode (note 18): SQLite, a filesystem object store, no email, no account, and a loopback
   * api nothing outside the machine can reach.
   *
   * It exists because `DATA_DRIVER=local` used to mean exactly one thing — a development stand-in for
   * the cloud topology — and is refused under `NODE_ENV=production` for that reason. A desktop install
   * *is* production and legitimately runs on SQLite, so the distinction has to be declared rather than
   * inferred from the driver: otherwise relaxing the guard for the app would also relax it for someone
   * about to deploy a hosted service on a single file.
   */
  DEPLOYMENT: enumWithDefaultVariable(["cloud", "local"], "cloud"),

  DATA_DRIVER: enumVariable(["d1", "local"]),
  EMAIL_DRIVER: enumVariable(["resend", "log"]),
  DURABLE: booleanVariable(false),
  KEY_PROVIDER: enumWithDefaultVariable(["env"], "env"),

  BETA_ACCESS_REQUIRED: booleanVariable(true),
  BILLING_ENABLED: disabledFlagVariable("billing"),
  PAYWALL_ENABLED: disabledFlagVariable("the paywall"),

  REMINDERS_ENABLED: booleanVariable(true),
  REMINDER_EMAIL_ENABLED: booleanVariable(true),
  REMINDER_MAX_LATENESS_HOURS: integerWithDefaultVariable({ min: 1, max: 168, default: 24 }),
  DEFAULT_TIMEZONE: timeZoneVariable("UTC"),
  DOC_MAX_BYTES: integerWithDefaultVariable({
    min: 1024,
    max: docMaxBytesLimit,
    default: docMaxBytesLimit,
  }),
  GIT_TMP_DIR: gitTmpDirVariable(),
  LOCAL_DATA_DIR: localDataDirVariable(),

  CLOUDFLARE_ACCOUNT_ID: optionalPatternVariable(
    /^[0-9a-f]{32}$/,
    "must be a Cloudflare account id (32 lowercase hexadecimal characters)",
  ),
  D1_DATABASE_ID: optionalPatternVariable(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "must be a D1 database id (a lowercase UUID)",
  ),
  R2_BUCKET: optionalPatternVariable(
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
    "must be an R2 bucket name (3 to 63 lowercase letters, digits and hyphens)",
  ),
  R2_ACCESS_KEY_ID: credentialVariable(),
  R2_SECRET_ACCESS_KEY: credentialVariable(),

  RESEND_API_KEY: credentialVariable(),

  ANALYTICS_ENABLED: booleanVariable(false),
  POSTHOG_PROJECT_KEY: posthogProjectKeyVariable(),
  POSTHOG_HOST: optionalOriginVariable("http"),
};

/** The values the shared cross-field rules read. */
export interface SharedRuleValues {
  readonly NODE_ENV: NodeEnv;
  readonly WEB_ORIGIN: string;
  readonly API_ORIGIN: string;
  readonly WS_ORIGIN: string;
  readonly DEPLOYMENT: "cloud" | "local";
  readonly DATA_DRIVER: "d1" | "local";
  readonly EMAIL_DRIVER: "resend" | "log";
  readonly DURABLE: boolean;
  readonly BETA_ACCESS_REQUIRED: boolean;
  readonly ANALYTICS_ENABLED: boolean;
  readonly POSTHOG_PROJECT_KEY?: string | undefined;
  readonly POSTHOG_HOST?: string | undefined;
  readonly CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  readonly D1_DATABASE_ID?: string | undefined;
  readonly R2_BUCKET?: string | undefined;
  readonly R2_ACCESS_KEY_ID?: string | undefined;
  readonly R2_SECRET_ACCESS_KEY?: string | undefined;
  readonly RESEND_API_KEY?: string | undefined;
}

function requireWhen(
  issues: ConfigIssue[],
  values: object,
  names: readonly string[],
  condition: string,
): void {
  const record = values as Readonly<Record<string, unknown>>;
  for (const name of names) {
    if (record[name] === undefined) {
      issues.push({ variable: name, message: `is required when ${condition}` });
    }
  }
}

/**
 * Cross-field rules shared by both runtimes (§16.1): production refuses the local drivers and
 * requires secure origins; drivers require their credentials; provider credential groups are
 * complete; analytics with a project key needs its host, which production refuses on loopback.
 */
export function sharedRuleIssues(
  values: SharedRuleValues,
  d1TokenVariable: "CLOUDFLARE_D1_API_TOKEN" | "CLOUDFLARE_D1_WORKER_API_TOKEN",
  d1TokenValue: string | undefined,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const production = values.NODE_ENV === "production";
  const local = values.DEPLOYMENT === "local";

  /*
   * A local deployment is the one production topology that runs on the local drivers, so its rules are
   * the inverse of the cloud's: the drivers it must use are the ones the cloud refuses, and the
   * credentials the cloud needs are ones it must not have. Declaring the deployment rather than
   * inferring it from `DATA_DRIVER` is what keeps "SQLite is fine here" from becoming "SQLite is fine
   * anywhere in production".
   */
  if (local) {
    if (values.DATA_DRIVER !== "local") {
      issues.push({
        variable: "DATA_DRIVER",
        message: "must be local when DEPLOYMENT=local: there is no D1 on one person's machine",
      });
    }
    if (values.EMAIL_DRIVER !== "log") {
      issues.push({
        variable: "EMAIL_DRIVER",
        message: "must be log when DEPLOYMENT=local: a local install sends no email",
      });
    }
    // Nothing reaches this api but the app that started it, and that is the whole security model: no
    // account, no OTP, no invite, and no listener anyone else can address.
    for (const name of ["WEB_ORIGIN", "API_ORIGIN", "WS_ORIGIN"] as const) {
      const url = parseOrigin(values[name], name === "WS_ORIGIN" ? "ws" : "http");
      if (url && !isLoopbackHostname(url.hostname)) {
        issues.push({
          variable: name,
          message: "must be a loopback origin when DEPLOYMENT=local (127.0.0.1 or localhost)",
        });
      }
    }
    if (values.DURABLE) {
      issues.push({
        variable: "DURABLE",
        message:
          "must be false when DEPLOYMENT=local: there is no Trigger.dev on one person's machine",
      });
    }
    if (values.BETA_ACCESS_REQUIRED) {
      issues.push({
        variable: "BETA_ACCESS_REQUIRED",
        message: "must be false when DEPLOYMENT=local: there is nobody to invite the owner",
      });
    }
  }

  if (production && !local) {
    if (values.DATA_DRIVER !== "d1") {
      issues.push({
        variable: "DATA_DRIVER",
        message:
          "must be d1 when NODE_ENV=production: the local driver is for development, or for DEPLOYMENT=local",
      });
    }
    if (values.EMAIL_DRIVER !== "resend") {
      issues.push({
        variable: "EMAIL_DRIVER",
        message: "must be resend when NODE_ENV=production: the log driver is for development only",
      });
    }
    for (const name of ["WEB_ORIGIN", "API_ORIGIN", "WS_ORIGIN"] as const) {
      const url = parseOrigin(values[name], name === "WS_ORIGIN" ? "ws" : "http");
      if (url && !isSecureOrigin(url)) {
        issues.push({
          variable: name,
          message: `must use ${name === "WS_ORIGIN" ? "wss" : "https"} when NODE_ENV=production`,
        });
      }
    }
  }

  const api = parseOrigin(values.API_ORIGIN, "http");
  const ws = parseOrigin(values.WS_ORIGIN, "ws");
  if (api && ws && api.host !== ws.host) {
    issues.push({
      variable: "WS_ORIGIN",
      message:
        "must have the same host and port as API_ORIGIN: the WebSocket gateway runs on the api",
    });
  }

  if (values.DATA_DRIVER === "d1" && !local) {
    requireWhen(
      issues,
      { ...values, [d1TokenVariable]: d1TokenValue },
      [
        "CLOUDFLARE_ACCOUNT_ID",
        "D1_DATABASE_ID",
        d1TokenVariable,
        "R2_BUCKET",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
      ],
      "DATA_DRIVER=d1",
    );
  }
  if (values.EMAIL_DRIVER === "resend" && !local) {
    requireWhen(issues, values, ["RESEND_API_KEY"], "EMAIL_DRIVER=resend");
  }

  if (values.POSTHOG_HOST !== undefined) {
    const host = parseOrigin(values.POSTHOG_HOST, "http");
    if (host && !isSecureOrigin(host) && !isLoopbackHostname(host.hostname)) {
      issues.push({
        variable: "POSTHOG_HOST",
        message: "must use https unless it is a loopback host",
      });
    }
    if (host && production && isLoopbackHostname(host.hostname)) {
      issues.push({
        variable: "POSTHOG_HOST",
        message: "must not be a loopback host when NODE_ENV=production",
      });
    }
  }
  if (values.ANALYTICS_ENABLED && values.POSTHOG_PROJECT_KEY !== undefined) {
    requireWhen(
      issues,
      values,
      ["POSTHOG_HOST"],
      "ANALYTICS_ENABLED=true and POSTHOG_PROJECT_KEY is set",
    );
  }

  return issues;
}

/** Converts a parsed family into the frozen config shape. */
export function toSecretFamilyConfig(family: ParsedSecretFamily): SecretFamilyConfig {
  return Object.freeze({ current: family.current, versions: new Map(family.versions) });
}

/** The parsed families of a runtime, keyed by family, or the issues that prevented parsing. */
export interface RuntimeSecrets {
  readonly families: Partial<Record<GeneratedSecretFamily, ParsedSecretFamily>>;
  readonly issues: readonly ConfigIssue[];
}

/**
 * Parses the runtime's secret families and applies the inventory checks: forbidden variables and
 * duplicate secret values (§4.5).
 */
export function runtimeSecrets(
  variables: Readonly<Record<string, string>>,
  runtime: SecretRuntime,
): RuntimeSecrets {
  const { families, issues } = parseSecretFamilies(variables, secretFamiliesFor(runtime));
  return {
    families,
    issues: [
      ...issues,
      ...rejectedSecretIssues(variables, runtime),
      ...duplicateSecretIssues(presentSecretEntries(variables)),
    ],
  };
}

/** Returns a family that parsing guaranteed to exist. */
export function familyConfig(
  families: Partial<Record<GeneratedSecretFamily, ParsedSecretFamily>>,
  family: GeneratedSecretFamily,
): SecretFamilyConfig {
  const parsed = families[family];
  if (!parsed) throw new Error(`Secret family ${family} was not parsed`);
  return toSecretFamilyConfig(parsed);
}

/** Removes keys whose value is undefined, so optional variables that are unset are absent. */
export function withoutUndefined<Value extends object>(value: Value): Value {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Value;
}

/**
 * Runs a runtime parser: validates the field shape, then hands the typed fields and present
 * variables to `build`, which adds rule and secret issues or returns the config.
 */
export function parseRuntime<Shape extends z.ZodRawShape, Config>(
  shape: Shape,
  env: EnvRecord,
  build: (
    fields: z.infer<z.ZodObject<Shape>> | undefined,
    variables: Readonly<Record<string, string>>,
    issues: ConfigIssue[],
  ) => Config | undefined,
): ConfigResult<Config> {
  const variables = presentVariables(env);
  const parsed = z.object(shape).safeParse(variables, { error: fallbackIssueMessage });
  const issues: ConfigIssue[] = parsed.success ? [] : issuesFromZod(parsed.error);
  const config = build(parsed.success ? parsed.data : undefined, variables, issues);
  if (issues.length > 0 || config === undefined) {
    return { ok: false, issues: normalizeIssues(issues) };
  }
  return { ok: true, config };
}

/** A Standard Schema for Nest's `ConfigModule.forRoot({ validationSchema })` (§16.1). */
export function configSchema<Config>(
  parse: (env: EnvRecord) => ConfigResult<Config>,
): z.ZodType<Config, EnvRecord> {
  return z.record(z.string(), z.string().optional()).transform((env, context) => {
    const result = parse(env);
    if (result.ok) return result.config;
    for (const issue of result.issues) {
      context.addIssue({ code: "custom", message: issue.message, path: [issue.variable] });
    }
    return z.NEVER;
  }) as unknown as z.ZodType<Config, EnvRecord>;
}
