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
import type { AiProvider, NodeEnv, SecretFamilyConfig } from "./shared.ts";

/**
 * Schemas and cross-field rules shared by the api and the worker (§16.1, §16.2). Node-only.
 */

export const nodeEnvs = ["development", "test", "production"] as const satisfies readonly NodeEnv[];
export const aiProviders = ["openai", "anthropic"] as const satisfies readonly AiProvider[];

/** Model ids from decision D8, used when `AI_FAST_MODEL` or `AI_SMART_MODEL` is unset. */
export const defaultAiModels = Object.freeze({ fast: "gpt-5.6-luna", smart: "gpt-5.6-terra" });

/** The largest document body: 1 MiB, so an encrypted draft stays within D1's 2 MB value limit (§3.2). */
export const docMaxBytesLimit = 1_048_576;

function modelIdVariable(defaultValue: string) {
  const invalid = "must be a provider model id such as gpt-5.6-luna";
  return z
    .string({ error: invalid })
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/, { error: invalid })
    .optional()
    .transform((value) => value ?? defaultValue);
}

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

  DATA_DRIVER: enumVariable(["d1", "local"]),
  EMAIL_DRIVER: enumVariable(["resend", "log"]),
  DURABLE: booleanVariable(false),
  KEY_PROVIDER: enumWithDefaultVariable(["env"], "env"),

  BETA_ACCESS_REQUIRED: booleanVariable(true),
  BILLING_ENABLED: disabledFlagVariable("billing"),
  PAYWALL_ENABLED: disabledFlagVariable("the paywall"),
  AI_USAGE_LIMITS_ENABLED: disabledFlagVariable("AI usage limits"),

  REMINDERS_ENABLED: booleanVariable(true),
  REMINDER_EMAIL_ENABLED: booleanVariable(true),
  REMINDER_MAX_LATENESS_HOURS: integerWithDefaultVariable({ min: 1, max: 168, default: 24 }),
  DEFAULT_TIMEZONE: timeZoneVariable("UTC"),
  QUICK_CHAT_TTL_HOURS: integerWithDefaultVariable({ min: 1, max: 168, default: 24 }),
  DOC_MAX_BYTES: integerWithDefaultVariable({
    min: 1024,
    max: docMaxBytesLimit,
    default: docMaxBytesLimit,
  }),
  GIT_TMP_DIR: gitTmpDirVariable(),
  LOCAL_DATA_DIR: localDataDirVariable(),

  AI_ENABLED: booleanVariable(true),
  AI_DEFAULT_TIER: enumWithDefaultVariable(["fast", "smart"], "fast"),
  AI_FAST_PROVIDER: enumWithDefaultVariable(aiProviders, "openai"),
  AI_FAST_MODEL: modelIdVariable(defaultAiModels.fast),
  AI_SMART_PROVIDER: enumWithDefaultVariable(aiProviders, "openai"),
  AI_SMART_MODEL: modelIdVariable(defaultAiModels.smart),
  AI_PROVIDER_MODE: enumWithDefaultVariable(["live", "scripted"], "live"),
  AI_TELEMETRY_ENABLED: booleanVariable(true),

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
  COMPOSIO_API_KEY: credentialVariable(),

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
  readonly DATA_DRIVER: "d1" | "local";
  readonly EMAIL_DRIVER: "resend" | "log";
  readonly AI_PROVIDER_MODE: "live" | "scripted";
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
 * Cross-field rules shared by both runtimes (§16.1): production refuses the local drivers and the
 * scripted model and requires secure origins; drivers require their credentials; provider
 * credential groups are complete; analytics with a project key needs its host, which production
 * refuses on loopback.
 */
export function sharedRuleIssues(
  values: SharedRuleValues,
  d1TokenVariable: "CLOUDFLARE_D1_API_TOKEN" | "CLOUDFLARE_D1_WORKER_API_TOKEN",
  d1TokenValue: string | undefined,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const production = values.NODE_ENV === "production";

  if (production) {
    if (values.DATA_DRIVER !== "d1") {
      issues.push({
        variable: "DATA_DRIVER",
        message: "must be d1 when NODE_ENV=production: the local driver is for development only",
      });
    }
    if (values.EMAIL_DRIVER !== "resend") {
      issues.push({
        variable: "EMAIL_DRIVER",
        message: "must be resend when NODE_ENV=production: the log driver is for development only",
      });
    }
    if (values.AI_PROVIDER_MODE !== "live") {
      issues.push({
        variable: "AI_PROVIDER_MODE",
        message:
          "must be live when NODE_ENV=production: the scripted model is for development only",
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

  if (values.DATA_DRIVER === "d1") {
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
  if (values.EMAIL_DRIVER === "resend") {
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
