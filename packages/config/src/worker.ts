import type { z } from "zod";
import { ConfigError, type ConfigIssue, type ConfigResult, unwrapConfig } from "./errors.ts";
import {
  credentialVariable,
  type EnvRecord,
  enumWithDefaultVariable,
  literalVariable,
  mailboxVariable,
  presentVariables,
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
import {
  type GeneratedSecretFamily,
  isSecretVariable,
  providerCredentialInventory,
  secretFamiliesFor,
} from "./secrets.ts";
import type { AiProviderCredentials, NodeEnv, SharedRuntimeConfig } from "./shared.ts";

/**
 * Validated worker (Trigger.dev) configuration: every worker and "both" variable in §16.2. The worker
 * never holds the api-only secret families, webhook secrets or the api D1 token (§4.5).
 */
export interface WorkerConfig extends SharedRuntimeConfig, AiProviderCredentials {
  /**
   * `production` in deployed Trigger.dev images and `development` under `trigger dev`; defaults to
   * `production` so a missing value never enables the local drivers.
   */
  NODE_ENV: NodeEnv;

  EMAIL_FROM_REMINDERS: string;

  /** Always `0`: Trigger must not auto-register AI SDK OpenTelemetry (§8.3). */
  TRIGGER_AI_SDK_OTEL_AUTOREGISTER: "0";
  /**
   * Injected by Trigger.dev into run processes and used only for task-to-task triggers, waits and
   * cancels; never part of the `syncEnvVars` allowlist (§4.5).
   */
  TRIGGER_SECRET_KEY?: string;

  /** The dedicated worker D1 token (§3.1); required when `DATA_DRIVER=d1`. */
  CLOUDFLARE_D1_WORKER_API_TOKEN?: string;
}

/** The worker's variables (§16.2) other than its secret families. */
export const workerVariableShape = {
  ...sharedVariableShape,
  NODE_ENV: enumWithDefaultVariable(nodeEnvs, "production"),
  EMAIL_FROM_REMINDERS: mailboxVariable(),
  TRIGGER_AI_SDK_OTEL_AUTOREGISTER: literalVariable("0"),
  TRIGGER_SECRET_KEY: triggerSecretKeyVariable(),
  CLOUDFLARE_D1_WORKER_API_TOKEN: credentialVariable(),
};

type WorkerFields = z.infer<z.ZodObject<typeof workerVariableShape>>;

/** The generated secret families the worker holds (§4.5). */
export const workerSecretFamilies: readonly GeneratedSecretFamily[] = Object.freeze(
  secretFamiliesFor("worker"),
);

/** Every fixed variable name the worker reads; families add `<NAME>_<n>` and `<NAME>_CURRENT`. */
export const workerVariableNames: readonly string[] = Object.freeze(
  Object.keys(workerVariableShape),
);

export interface WorkerParseOptions {
  /**
   * Whether values Trigger.dev injects into run processes are expected (`TRIGGER_SECRET_KEY` when
   * `DURABLE=true`). True at task startup; false when validating the synced variables at deploy time.
   */
  readonly platformInjected: boolean;
}

function workerRuleIssues(fields: WorkerFields, options: WorkerParseOptions): ConfigIssue[] {
  const issues = sharedRuleIssues(
    fields,
    "CLOUDFLARE_D1_WORKER_API_TOKEN",
    fields.CLOUDFLARE_D1_WORKER_API_TOKEN,
  );
  if (fields.DURABLE && options.platformInjected && fields.TRIGGER_SECRET_KEY === undefined) {
    issues.push({
      variable: "TRIGGER_SECRET_KEY",
      message: "is required when DURABLE=true: Trigger.dev injects it into every run process",
    });
  }
  return issues;
}

/** Validates a worker environment without throwing. */
export function parseWorkerConfig(
  env: EnvRecord,
  options: WorkerParseOptions = { platformInjected: true },
): ConfigResult<WorkerConfig> {
  return parseRuntime(workerVariableShape, env, (fields, variables, issues) => {
    const secrets = runtimeSecrets(variables, "worker", fields?.DURABLE ?? false);
    issues.push(...secrets.issues);
    if (!fields) return undefined;
    issues.push(...workerRuleIssues(fields, options));
    if (issues.length > 0) return undefined;
    const config: WorkerConfig = {
      ...withoutUndefined(fields),
      CONTENT_KEK: familyConfig(secrets.families, "CONTENT_KEK"),
      INTERNAL_EVENT_SECRET: familyConfig(secrets.families, "INTERNAL_EVENT_SECRET"),
      REMINDER_UNSUBSCRIBE_SECRET: familyConfig(secrets.families, "REMINDER_UNSUBSCRIBE_SECRET"),
    };
    return Object.freeze(config);
  });
}

/**
 * Validates the worker environment (`process.env` by default) at task startup. Throws a
 * `ConfigError` naming every problem, including every api-only secret that is present (§4.5).
 */
export function loadWorkerConfig(env: EnvRecord = process.env): WorkerConfig {
  return unwrapConfig("worker", parseWorkerConfig(env));
}

/** The worker schema as a Standard Schema. */
export const workerConfigSchema = configSchema((env) => parseWorkerConfig(env));

/* ------------------------------------------------------------------------------------------------
 * syncEnvVars allowlist (§4.5, §8.8)
 * --------------------------------------------------------------------------------------------- */

/** One variable `trigger.config.ts` syncs to Trigger.dev. */
export interface WorkerSyncEnvVar {
  readonly name: string;
  readonly value: string;
  readonly isSecret: boolean;
}

/**
 * Trigger.dev's `syncEnvVars` extension silently drops every name starting with `TRIGGER_` (its
 * `UNSYNCABLE_ENV_VARS_PREFIXES`), so no `TRIGGER_*` variable can travel through the allowlist.
 */
export const triggerUnsyncablePrefix = "TRIGGER_";

/**
 * Variables never synced even though the worker reads them: `TRIGGER_SECRET_KEY` is injected by
 * Trigger.dev itself (the api's key must never reach Trigger), `NODE_ENV` is set by the image,
 * `TRIGGER_AI_SDK_OTEL_AUTOREGISTER` comes from `workerImageEnv` because sync would drop it, and
 * `LOCAL_DATA_DIR` names a directory on a developer machine, which means nothing in a deployed image
 * (where the local drivers are refused).
 */
export const workerSyncExcludedVariables: readonly string[] = Object.freeze(
  workerVariableNames.filter(
    (name) =>
      name === "NODE_ENV" || name === "LOCAL_DATA_DIR" || name.startsWith(triggerUnsyncablePrefix),
  ),
);

/**
 * Fixed values the deployed worker image must carry (§8.3): `TRIGGER_AI_SDK_OTEL_AUTOREGISTER=0`.
 * `syncEnvVars` cannot deliver a `TRIGGER_*` name, so `trigger.config.ts` bakes these into the image
 * with a build layer: `context.addLayer({ id: "symplist-env", image: { instructions:
 * workerImageEnvInstructions } })`. The worker schema still requires them at task startup.
 */
export const workerImageEnv: Readonly<{ TRIGGER_AI_SDK_OTEL_AUTOREGISTER: "0" }> = Object.freeze({
  TRIGGER_AI_SDK_OTEL_AUTOREGISTER: "0",
});

/** Dockerfile `ENV` instructions for `workerImageEnv`. */
export const workerImageEnvInstructions: readonly string[] = Object.freeze(
  Object.entries(workerImageEnv).map(([name, value]) => `ENV ${name}=${value}`),
);

/**
 * The fixed variable names the worker syncs, with whether each is secret. Secret families sync as
 * `<NAME>_<n>` (secret) and `<NAME>_CURRENT` (not secret) for each family in
 * `workerSecretFamilies`. Variables removed from this list must be deleted from Trigger by hand,
 * because sync never deletes.
 */
export const workerSyncAllowlist: readonly { readonly name: string; readonly isSecret: boolean }[] =
  Object.freeze(
    workerVariableNames
      .filter((name) => !workerSyncExcludedVariables.includes(name))
      .map((name) => Object.freeze({ name, isSecret: isSecretVariable(name) })),
  );

const allowlistedNames = new Map(workerSyncAllowlist.map(({ name, isSecret }) => [name, isSecret]));

function familySyncEntry(name: string): { readonly isSecret: boolean } | undefined {
  for (const family of workerSecretFamilies) {
    if (!name.startsWith(`${family}_`)) continue;
    const suffix = name.slice(family.length + 1);
    if (suffix === "CURRENT") return { isSecret: false };
    if (/^[1-9][0-9]{0,8}$/.test(suffix)) return { isSecret: true };
  }
  return undefined;
}

/** Whether `trigger.config.ts` may sync a variable, and whether it is secret. */
export function workerSyncEntry(name: string): { readonly isSecret: boolean } | undefined {
  if (Object.hasOwn(providerCredentialInventory, name) && !allowlistedNames.has(name)) {
    return undefined;
  }
  const fixed = allowlistedNames.get(name);
  return fixed === undefined ? familySyncEntry(name) : { isSecret: fixed };
}

/**
 * The variables to sync from a deploy environment (typically CI's `process.env`), for
 * `syncEnvVars(() => workerSyncEnvVars(process.env))` in `trigger.config.ts`. Only allowlisted names
 * are selected, and the selection is validated with the worker schema (together with
 * `workerImageEnv`, which the image provides) before anything is returned, so an invalid or forbidden
 * configuration is never synced. Throws a `ConfigError` naming the problems.
 *
 * Trigger.dev catches errors thrown inside the `syncEnvVars` callback and only logs a warning, so a
 * throw here skips the sync but does not stop the deploy. To fail the deploy, `trigger.config.ts` must
 * catch the `ConfigError`, print it and exit non-zero.
 */
export function workerSyncEnvVars(env: EnvRecord): WorkerSyncEnvVar[] {
  const selected: Record<string, string> = {};
  for (const [name, value] of Object.entries(presentVariables(env))) {
    if (workerSyncEntry(name)) selected[name] = value;
  }
  const result = parseWorkerConfig({ ...selected, ...workerImageEnv }, { platformInjected: false });
  if (!result.ok) throw new ConfigError("worker", result.issues);
  return Object.entries(selected)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => ({ name, value, isSecret: workerSyncEntry(name)?.isSecret ?? true }));
}

/**
 * Selects a complete explicitly supplied deployment environment, or performs no sync at all.
 *
 * Trigger's linked GitHub builder deliberately does not expose runtime secrets to the image-build
 * process. In that environment none of Symplist's allowlisted variables is present, so returning an
 * empty selection preserves the variables already managed by Trigger. If even one allowlisted value
 * is present (as in a local/CI CLI deploy), the complete worker schema is still mandatory: a partial
 * or invalid selection fails closed through {@link workerSyncEnvVars}.
 */
export function workerSyncEnvVarsWhenPresent(env: EnvRecord): WorkerSyncEnvVar[] {
  const hasAllowlistedValue = Object.keys(presentVariables(env)).some(
    (name) => workerSyncEntry(name) !== undefined,
  );
  return hasAllowlistedValue ? workerSyncEnvVars(env) : [];
}
