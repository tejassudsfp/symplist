import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { GeneratedSecretFamily } from "../secrets.ts";

/**
 * Throwaway configuration for config tests. Every secret and credential is generated per call, so no
 * fixture holds a real or reusable value.
 */

export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** A fresh generated secret: 32 random bytes as base64url. */
export const generatedSecret = (): string => randomBytes(32).toString("base64url");

/** A fresh opaque provider credential with an optional prefix. */
export const credential = (prefix = ""): string => `${prefix}${randomBytes(24).toString("hex")}`;

/** `<NAME>_1` and `<NAME>_CURRENT=1` for each family, with fresh values. */
export function familyVariables(
  families: readonly GeneratedSecretFamily[],
): Record<string, string> {
  return Object.fromEntries(
    families.flatMap((family) => [
      [`${family}_1`, generatedSecret()],
      [`${family}_CURRENT`, "1"],
    ]),
  );
}

export const apiFamilies: readonly GeneratedSecretFamily[] = [
  "CONTENT_KEK",
  "INTERNAL_EVENT_SECRET",
  "REMINDER_UNSUBSCRIBE_SECRET",
  "VAULT_RECOVERY_KEY",
  "SESSION_DIGEST_SECRET",
  "OTP_DIGEST_SECRET",
  "INVITE_DIGEST_SECRET",
  "SHARE_DIGEST_SECRET",
  "SHARE_SESSION_DIGEST_SECRET",
  "MCP_TOKEN_DIGEST_SECRET",
  "MCP_OAUTH_SIGNING_KEY",
  "IDEMPOTENCY_SECRET",
];

export const workerFamilies: readonly GeneratedSecretFamily[] = [
  "CONTENT_KEK",
  "INTERNAL_EVENT_SECRET",
  "REMINDER_UNSUBSCRIBE_SECRET",
];

/** A minimal valid local-development api environment. */
export function localApiEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: "development",
    WEB_ORIGIN: "http://localhost:3000",
    API_ORIGIN: "http://localhost:4000",
    WS_ORIGIN: "ws://localhost:4000",
    ARTIFACT_ORIGIN: "http://127.0.0.1:4000",
    DATA_DRIVER: "local",
    EMAIL_DRIVER: "log",
    DURABLE: "false",
    EMAIL_FROM_SECURITY: "Symplist <security@example.com>",
    EMAIL_FROM_REMINDERS: "reminders@example.com",
    ...familyVariables(apiFamilies),
    ...overrides,
  };
}

/** Variables that configure D1, R2 and Resend with throwaway credentials. */
function hostedProviders(d1TokenVariable: string) {
  return {
    DATA_DRIVER: "d1",
    EMAIL_DRIVER: "resend",
    CLOUDFLARE_ACCOUNT_ID: randomBytes(16).toString("hex"),
    D1_DATABASE_ID: randomUUID(),
    [d1TokenVariable]: credential(),
    R2_BUCKET: "symplist-objects",
    R2_ACCESS_KEY_ID: credential(),
    R2_SECRET_ACCESS_KEY: credential(),
    RESEND_API_KEY: credential("re_"),
    COMPOSIO_API_KEY: credential(),
  };
}

/** A valid production api environment in durable mode. */
export function productionApiEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    PORT: "10000",
    WEB_ORIGIN: "https://symplist.example.com",
    API_ORIGIN: "https://api.symplist.example.com",
    WS_ORIGIN: "wss://api.symplist.example.com",
    ARTIFACT_ORIGIN: "https://share.symplist.example.com",
    TRUST_PROXY_HOPS: "1",
    ...hostedProviders("CLOUDFLARE_D1_API_TOKEN"),
    DURABLE: "true",
    TRIGGER_SECRET_KEY: credential("tr_prod_"),
    TRIGGER_PROJECT_REF: "proj_rryekrktnjnrdzvabzqd",
    EMAIL_FROM_SECURITY: "Symplist <security@symplist.example.com>",
    RESEND_WEBHOOK_SECRET: credential("whsec_"),
    COMPOSIO_WEBHOOK_SECRET: credential(),
    ANALYTICS_ENABLED: "true",
    POSTHOG_PROJECT_KEY: credential("phc_"),
    POSTHOG_HOST: "https://us.i.posthog.com",
    POSTHOG_PERSONAL_API_KEY: credential("phx_"),
    POSTHOG_PROJECT_ID: "12345",
    ...familyVariables(apiFamilies),
    ...overrides,
  };
}

/** A minimal valid local-development worker environment. */
export function localWorkerEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: "development",
    WEB_ORIGIN: "http://localhost:3000",
    API_ORIGIN: "http://localhost:4000",
    WS_ORIGIN: "ws://localhost:4000",
    DATA_DRIVER: "local",
    EMAIL_DRIVER: "log",
    DURABLE: "false",
    EMAIL_FROM_REMINDERS: "Symplist <reminders@example.com>",
    TRIGGER_AI_SDK_OTEL_AUTOREGISTER: "0",
    ...familyVariables(workerFamilies),
    ...overrides,
  };
}

/** A valid deployed worker environment, including the platform-injected Trigger.dev key. */
export function productionWorkerEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    WEB_ORIGIN: "https://symplist.example.com",
    API_ORIGIN: "https://api.symplist.example.com",
    WS_ORIGIN: "wss://api.symplist.example.com",
    ...hostedProviders("CLOUDFLARE_D1_WORKER_API_TOKEN"),
    DURABLE: "true",
    EMAIL_FROM_REMINDERS: "Symplist <reminders@symplist.example.com>",
    TRIGGER_AI_SDK_OTEL_AUTOREGISTER: "0",
    TRIGGER_SECRET_KEY: credential("tr_prod_"),
    ...familyVariables(workerFamilies),
    ...overrides,
  };
}

/** The path of `scripts/secrets-generate.mjs`. */
export const secretsGenerateScript = fileURLToPath(
  new URL("../../../../scripts/secrets-generate.mjs", import.meta.url),
);

/** Runs `scripts/secrets-generate.mjs` with Node and returns its result. */
export function runSecretsGenerate(args: readonly string[] = [], cwd = repoRoot) {
  return spawnSync(process.execPath, [secretsGenerateScript, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
}

/** Parses a checked-in environment template with Node's env file parser. */
export function readEnvExample(app: "api" | "worker" | "web") {
  const text = readFileSync(
    new URL(`../../../../apps/${app}/env.example`, import.meta.url),
    "utf8",
  );
  return { text, variables: parseEnv(text) as Record<string, string> };
}
