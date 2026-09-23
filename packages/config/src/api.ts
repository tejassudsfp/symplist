import type { z } from "zod";
import { type ConfigIssue, type ConfigResult, unwrapConfig } from "./errors.ts";
import {
  booleanVariable,
  credentialVariable,
  type EnvRecord,
  enumVariable,
  integerWithDefaultVariable,
  isSecureOrigin,
  mailboxVariable,
  optionalEmailVariable,
  optionalIntegerVariable,
  optionalMailboxVariable,
  optionalPatternVariable,
  originVariable,
  parseOrigin,
} from "./fields.ts";
import {
  configSchema,
  familyConfig,
  nodeEnvs,
  parseRuntime,
  runtimeSecrets,
  sharedRuleIssues,
  sharedVariableShape,
  triggerSecretKeyVariable,
  withoutUndefined,
} from "./runtime.ts";
import { type GeneratedSecretFamily, secretFamiliesFor } from "./secrets.ts";
import type {
  AiProviderCredentials,
  NodeEnv,
  SecretFamilyConfig,
  SharedRuntimeConfig,
} from "./shared.ts";

/** Validated api (Render) configuration: every api and "both" variable in §16.2. */
export interface ApiConfig extends SharedRuntimeConfig, AiProviderCredentials {
  NODE_ENV: NodeEnv;
  PORT: number;

  /** Share host origin (§13.2). */
  ARTIFACT_ORIGIN: string;
  ADMIN_BOOTSTRAP_EMAIL?: string;
  /** Measured at first deploy (§5.8). */
  TRUST_PROXY_HOPS: number;

  OTP_LENGTH: number;
  OTP_TTL_MINUTES: number;
  OTP_MAX_ATTEMPTS: number;
  VAULT_IDLE_LOCK_MINUTES: number;

  EMAIL_FROM_SECURITY: string;
  /** Used by the api only when `DURABLE=false`. */
  EMAIL_FROM_REMINDERS?: string;

  /** Starts, polls and cancels Trigger runs; required when `DURABLE=true`. */
  TRIGGER_SECRET_KEY?: string;
  TRIGGER_PROJECT_REF?: string;
  /**
   * Dispatch a Simon turn into the conversation's durable chat session instead of a fresh
   * `simon-run` task, so a follow-up inside the idle window answers from a parked run (§8.1).
   */
  SIMON_CHAT_SESSIONS: boolean;

  /** The api D1 lane token (§3.1); required when `DATA_DRIVER=d1`. */
  CLOUDFLARE_D1_API_TOKEN?: string;

  RESEND_WEBHOOK_SECRET?: string;
  COMPOSIO_WEBHOOK_SECRET?: string;

  /** Account deletion requests PostHog person deletion (§5.6). */
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;

  VAULT_RECOVERY_KEY: SecretFamilyConfig;
  SESSION_DIGEST_SECRET: SecretFamilyConfig;
  OTP_DIGEST_SECRET: SecretFamilyConfig;
  INVITE_DIGEST_SECRET: SecretFamilyConfig;
  SHARE_DIGEST_SECRET: SecretFamilyConfig;
  SHARE_SESSION_DIGEST_SECRET: SecretFamilyConfig;
  MCP_TOKEN_DIGEST_SECRET: SecretFamilyConfig;
  /** JWT `kid` is the version (§14.4). */
  MCP_OAUTH_SIGNING_KEY: SecretFamilyConfig;
  IDEMPOTENCY_SECRET: SecretFamilyConfig;
}

/** The api's variables (§16.2) other than its secret families. */
export const apiVariableShape = {
  ...sharedVariableShape,
  NODE_ENV: enumVariable(nodeEnvs),
  PORT: integerWithDefaultVariable({ min: 1, max: 65_535, default: 4000 }),

  ARTIFACT_ORIGIN: originVariable("http"),
  ADMIN_BOOTSTRAP_EMAIL: optionalEmailVariable(),
  TRUST_PROXY_HOPS: optionalIntegerVariable({ min: 0, max: 10 }),

  OTP_LENGTH: integerWithDefaultVariable({ min: 6, max: 8, default: 6 }),
  OTP_TTL_MINUTES: integerWithDefaultVariable({ min: 1, max: 60, default: 10 }),
  OTP_MAX_ATTEMPTS: integerWithDefaultVariable({ min: 1, max: 10, default: 5 }),
  VAULT_IDLE_LOCK_MINUTES: integerWithDefaultVariable({ min: 1, max: 60, default: 5 }),

  EMAIL_FROM_SECURITY: mailboxVariable(),
  EMAIL_FROM_REMINDERS: optionalMailboxVariable(),

  TRIGGER_SECRET_KEY: triggerSecretKeyVariable(),
  TRIGGER_PROJECT_REF: optionalPatternVariable(
    /^proj_[a-z0-9]{8,64}$/,
    "must be a Trigger.dev project ref (proj_…)",
  ),
  SIMON_CHAT_SESSIONS: booleanVariable(false),

  CLOUDFLARE_D1_API_TOKEN: credentialVariable(),

  RESEND_WEBHOOK_SECRET: credentialVariable(),
  COMPOSIO_WEBHOOK_SECRET: credentialVariable(),

  POSTHOG_PERSONAL_API_KEY: credentialVariable(),
  POSTHOG_PROJECT_ID: optionalPatternVariable(
    /^[1-9][0-9]{0,15}$/,
    "must be a numeric PostHog project id",
  ),
};

type ApiFields = z.infer<z.ZodObject<typeof apiVariableShape>>;

/** The generated secret families the api holds (§4.5). */
export const apiSecretFamilies: readonly GeneratedSecretFamily[] = Object.freeze(
  secretFamiliesFor("api"),
);

/** Every fixed variable name the api reads; families add `<NAME>_<n>` and `<NAME>_CURRENT`. */
export const apiVariableNames: readonly string[] = Object.freeze(Object.keys(apiVariableShape));

function apiRuleIssues(fields: ApiFields): ConfigIssue[] {
  const issues = sharedRuleIssues(
    fields,
    "CLOUDFLARE_D1_API_TOKEN",
    fields.CLOUDFLARE_D1_API_TOKEN,
  );
  const production = fields.NODE_ENV === "production";

  const artifact = parseOrigin(fields.ARTIFACT_ORIGIN, "http");
  if (artifact) {
    if (production && !isSecureOrigin(artifact)) {
      issues.push({
        variable: "ARTIFACT_ORIGIN",
        message: "must use https when NODE_ENV=production",
      });
    }
    for (const other of ["API_ORIGIN", "WEB_ORIGIN"] as const) {
      const url = parseOrigin(fields[other], "http");
      if (url && url.hostname === artifact.hostname) {
        issues.push({
          variable: "ARTIFACT_ORIGIN",
          message: `must use a different host from ${other}, so session cookies never reach the share host`,
        });
      }
    }
  }

  if (production && fields.TRUST_PROXY_HOPS === undefined) {
    issues.push({
      variable: "TRUST_PROXY_HOPS",
      message: "is required when NODE_ENV=production: measure the proxy hops at first deploy",
    });
  }

  if (fields.DURABLE) {
    for (const name of ["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_REF"] as const) {
      if (fields[name] === undefined) {
        issues.push({ variable: name, message: "is required when DURABLE=true" });
      }
    }
  } else if (fields.EMAIL_FROM_REMINDERS === undefined) {
    issues.push({
      variable: "EMAIL_FROM_REMINDERS",
      message: "is required when DURABLE=false: the api sends reminder email",
    });
  }

  if (fields.SIMON_CHAT_SESSIONS && !fields.DURABLE) {
    issues.push({
      variable: "SIMON_CHAT_SESSIONS",
      message: "needs DURABLE=true: a chat session only exists on Trigger",
    });
  }

  if (fields.ANALYTICS_ENABLED && fields.POSTHOG_PROJECT_KEY !== undefined) {
    for (const name of ["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID"] as const) {
      if (fields[name] === undefined) {
        issues.push({
          variable: name,
          message:
            "is required when ANALYTICS_ENABLED=true and POSTHOG_PROJECT_KEY is set: account deletion must delete PostHog data",
        });
      }
    }
  }
  if (fields.POSTHOG_PERSONAL_API_KEY !== undefined && fields.POSTHOG_PROJECT_ID === undefined) {
    issues.push({
      variable: "POSTHOG_PROJECT_ID",
      message: "is required when POSTHOG_PERSONAL_API_KEY is set",
    });
  }

  return issues;
}

/** Validates an api environment without throwing. */
export function parseApiConfig(env: EnvRecord): ConfigResult<ApiConfig> {
  return parseRuntime(apiVariableShape, env, (fields, variables, issues) => {
    const secrets = runtimeSecrets(variables, "api");
    issues.push(...secrets.issues);
    if (!fields) return undefined;
    issues.push(...apiRuleIssues(fields));
    if (issues.length > 0) return undefined;

    const families = Object.fromEntries(
      apiSecretFamilies.map((family) => [family, familyConfig(secrets.families, family)]),
    ) as Record<(typeof apiSecretFamilies)[number], SecretFamilyConfig>;

    const config: ApiConfig = {
      ...withoutUndefined(fields),
      TRUST_PROXY_HOPS: fields.TRUST_PROXY_HOPS ?? 0,
      CONTENT_KEK: families.CONTENT_KEK,
      INTERNAL_EVENT_SECRET: families.INTERNAL_EVENT_SECRET,
      REMINDER_UNSUBSCRIBE_SECRET: families.REMINDER_UNSUBSCRIBE_SECRET,
      VAULT_RECOVERY_KEY: families.VAULT_RECOVERY_KEY,
      SESSION_DIGEST_SECRET: families.SESSION_DIGEST_SECRET,
      OTP_DIGEST_SECRET: families.OTP_DIGEST_SECRET,
      INVITE_DIGEST_SECRET: families.INVITE_DIGEST_SECRET,
      SHARE_DIGEST_SECRET: families.SHARE_DIGEST_SECRET,
      SHARE_SESSION_DIGEST_SECRET: families.SHARE_SESSION_DIGEST_SECRET,
      MCP_TOKEN_DIGEST_SECRET: families.MCP_TOKEN_DIGEST_SECRET,
      MCP_OAUTH_SIGNING_KEY: families.MCP_OAUTH_SIGNING_KEY,
      IDEMPOTENCY_SECRET: families.IDEMPOTENCY_SECRET,
    };
    return Object.freeze(config);
  });
}

/**
 * Validates the api environment (`process.env` by default) and returns the typed configuration.
 * Throws a `ConfigError` listing every problem by variable name, never by value (§16.1).
 */
export function loadApiConfig(env: EnvRecord = process.env): ApiConfig {
  return unwrapConfig("api", parseApiConfig(env));
}

/**
 * The api schema as a Standard Schema, for
 * `ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, cache: true, validationSchema })`.
 */
export const apiConfigSchema = configSchema(parseApiConfig);
