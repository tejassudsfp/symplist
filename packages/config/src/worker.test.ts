import { describe, expect, it } from "vitest";
import { ConfigError, type ConfigIssue } from "./errors.ts";
import { generatedSecretFamilies, providerCredentialInventory } from "./secrets.ts";
import {
  credential,
  generatedSecret,
  localWorkerEnv,
  productionWorkerEnv,
} from "./testing/fixtures.ts";
import {
  loadWorkerConfig,
  parseWorkerConfig,
  workerConfigSchema,
  workerSecretFamilies,
  workerSyncAllowlist,
  workerSyncEntry,
  workerSyncEnvVars,
  workerVariableNames,
} from "./worker.ts";

function issuesOf(
  env: Record<string, string | undefined>,
  options?: Parameters<typeof parseWorkerConfig>[1],
): readonly ConfigIssue[] {
  const result = parseWorkerConfig(env, options);
  if (result.ok) throw new Error("expected the configuration to be invalid");
  return result.issues;
}

const issue = (variable: string, message: string) =>
  expect.objectContaining({ variable, message: expect.stringContaining(message) });

/** Every api-only secret the worker must refuse (§4.5), each with a throwaway value. */
function apiOnlySecrets(): Record<string, string> {
  return {
    VAULT_RECOVERY_KEY_1: generatedSecret(),
    VAULT_RECOVERY_KEY_CURRENT: "1",
    SESSION_DIGEST_SECRET_1: generatedSecret(),
    OTP_DIGEST_SECRET_1: generatedSecret(),
    INVITE_DIGEST_SECRET_1: generatedSecret(),
    SHARE_DIGEST_SECRET_1: generatedSecret(),
    SHARE_SESSION_DIGEST_SECRET_1: generatedSecret(),
    MCP_TOKEN_DIGEST_SECRET_1: generatedSecret(),
    MCP_OAUTH_SIGNING_KEY_1: generatedSecret(),
    IDEMPOTENCY_SECRET_1: generatedSecret(),
    RESEND_WEBHOOK_SECRET: credential("whsec_"),
    COMPOSIO_WEBHOOK_SECRET: credential(),
    POSTHOG_PERSONAL_API_KEY: credential("phx_"),
    CLOUDFLARE_D1_API_TOKEN: credential(),
    CLOUDFLARE_D1_MIGRATE_API_TOKEN: credential(),
    TRIGGER_ACCESS_TOKEN: credential("tr_pat_"),
  };
}

describe("worker configuration: valid environments", () => {
  it("loads a local development environment", () => {
    const env = localWorkerEnv();
    const config = loadWorkerConfig(env);
    expect(config).toMatchObject({
      NODE_ENV: "development",
      DATA_DRIVER: "local",
      DURABLE: false,
      TRIGGER_AI_SDK_OTEL_AUTOREGISTER: "0",
      EMAIL_FROM_REMINDERS: "Symplist <reminders@example.com>",
    });
    expect(config.CONTENT_KEK.versions.get(1)).toBe(env.CONTENT_KEK_1);
    expect(Object.keys(config)).not.toContain("VAULT_RECOVERY_KEY");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("loads a deployed environment with the platform-injected Trigger.dev key", () => {
    const env = productionWorkerEnv();
    const config = loadWorkerConfig(env);
    expect(config.NODE_ENV).toBe("production");
    expect(config.TRIGGER_SECRET_KEY).toBe(env.TRIGGER_SECRET_KEY);
    expect(config.OPENAI_API_KEY).toBe(env.OPENAI_API_KEY);
  });

  it("works as a Standard Schema", async () => {
    expect(
      (await workerConfigSchema["~standard"].validate(localWorkerEnv())).issues,
    ).toBeUndefined();
  });
});

describe("worker configuration: rules", () => {
  it("defaults NODE_ENV to production, so the local drivers are refused when it is missing", () => {
    const issues = issuesOf(localWorkerEnv({ NODE_ENV: undefined }));
    expect(issues).toEqual(
      expect.arrayContaining([
        issue("DATA_DRIVER", "must be d1 when NODE_ENV=production"),
        issue("EMAIL_DRIVER", "must be resend when NODE_ENV=production"),
        issue("WEB_ORIGIN", "must use https when NODE_ENV=production"),
        issue("API_ORIGIN", "must use https when NODE_ENV=production"),
        issue("WS_ORIGIN", "must use wss when NODE_ENV=production"),
      ]),
    );
    expect(issues).toHaveLength(5);
  });

  it("requires TRIGGER_AI_SDK_OTEL_AUTOREGISTER=0", () => {
    expect(issuesOf(localWorkerEnv({ TRIGGER_AI_SDK_OTEL_AUTOREGISTER: undefined }))).toEqual([
      issue("TRIGGER_AI_SDK_OTEL_AUTOREGISTER", "is required"),
    ]);
    expect(issuesOf(localWorkerEnv({ TRIGGER_AI_SDK_OTEL_AUTOREGISTER: "1" }))).toEqual([
      issue("TRIGGER_AI_SDK_OTEL_AUTOREGISTER", "must be 0"),
    ]);
  });

  it("requires the platform-injected TRIGGER_SECRET_KEY in durable run processes only", () => {
    expect(issuesOf(productionWorkerEnv({ TRIGGER_SECRET_KEY: undefined }))).toEqual([
      issue("TRIGGER_SECRET_KEY", "Trigger.dev injects it"),
    ]);
    expect(
      parseWorkerConfig(productionWorkerEnv({ TRIGGER_SECRET_KEY: undefined }), {
        platformInjected: false,
      }).ok,
    ).toBe(true);
    expect(issuesOf(productionWorkerEnv({ TRIGGER_SECRET_KEY: "not-a-trigger-key" }))).toEqual([
      issue("TRIGGER_SECRET_KEY", "Trigger.dev secret key"),
    ]);
  });

  it.each([
    "CLOUDFLARE_ACCOUNT_ID",
    "D1_DATABASE_ID",
    "CLOUDFLARE_D1_WORKER_API_TOKEN",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ])("DATA_DRIVER=d1 requires %s", (name) => {
    expect(issuesOf(productionWorkerEnv({ [name]: undefined }))).toEqual([
      issue(name, "is required when DATA_DRIVER=d1"),
    ]);
  });

  it.each(["BILLING_ENABLED", "PAYWALL_ENABLED", "AI_USAGE_LIMITS_ENABLED"])(
    "rejects %s=true",
    (name) => {
      expect(issuesOf(localWorkerEnv({ [name]: "true" }))).toEqual([issue(name, "must be false")]);
    },
  );

  it("holds AI provider credentials even when DURABLE=true", () => {
    expect(parseWorkerConfig(productionWorkerEnv({ TOGETHER_API_KEY: credential() })).ok).toBe(
      true,
    );
  });

  it.each([...workerSecretFamilies])("requires the shared %s family", (family) => {
    expect(
      issuesOf(localWorkerEnv({ [`${family}_1`]: undefined, [`${family}_CURRENT`]: undefined })),
    ).toEqual([issue(`${family}_CURRENT`, "is required")]);
  });

  it("rejects equal secret values", () => {
    const shared = generatedSecret();
    expect(
      issuesOf(localWorkerEnv({ CONTENT_KEK_1: shared, REMINDER_UNSUBSCRIBE_SECRET_1: shared })),
    ).toEqual([
      issue("REMINDER_UNSUBSCRIBE_SECRET_1", "must not reuse the value of CONTENT_KEK_1"),
    ]);
  });
});

describe("worker configuration: forbidden secrets at startup (§4.5)", () => {
  it.each(Object.entries(apiOnlySecrets()))("refuses to start with %s set", (name, value) => {
    const env = productionWorkerEnv({ [name]: value });
    expect(issuesOf(env)).toContainEqual(issue(name, "must not be set on the worker"));
    expect(() => loadWorkerConfig(env)).toThrow(ConfigError);
  });

  it("reports every forbidden secret at once without echoing any value", () => {
    const secrets = apiOnlySecrets();
    let error: ConfigError | undefined;
    try {
      loadWorkerConfig(productionWorkerEnv({ ...secrets, SESSION_DIGEST_SECRET_CURRENT: "1" }));
    } catch (caught) {
      error = caught as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const variables = new Set(error?.issues.map((entry) => entry.variable));
    for (const name of Object.keys(secrets)) expect(variables).toContain(name);
    expect(variables).toContain("SESSION_DIGEST_SECRET_CURRENT");
    for (const value of Object.values(secrets)) {
      if (value.length > 1) expect(error?.message).not.toContain(value);
    }
  });

  it("never echoes invalid values", () => {
    const marker = "LEAKMARKER";
    const env: Record<string, string> = {};
    for (const name of workerVariableNames) env[name] = `${marker} ${name}`;
    for (const family of workerSecretFamilies) {
      env[`${family}_1`] = `${marker}`.padEnd(43, "_");
      env[`${family}_CURRENT`] = marker;
    }
    const result = parseWorkerConfig(env);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});

describe("worker syncEnvVars allowlist (§4.5, §8.8)", () => {
  it("never contains TRIGGER_SECRET_KEY, NODE_ENV or any secret the worker must not hold", () => {
    const names = workerSyncAllowlist.map((entry) => entry.name);
    expect(names).not.toContain("TRIGGER_SECRET_KEY");
    expect(names).not.toContain("NODE_ENV");
    expect(workerSyncEntry("TRIGGER_SECRET_KEY")).toBeUndefined();
    expect(workerSyncEntry("TRIGGER_API_URL")).toBeUndefined();
    for (const name of Object.keys(apiOnlySecrets())) expect(workerSyncEntry(name)).toBeUndefined();
    for (const family of generatedSecretFamilies) {
      const synced = workerSecretFamilies.includes(family);
      expect(workerSyncEntry(`${family}_1`) !== undefined).toBe(synced);
    }
  });

  it("covers every worker variable except the platform-set ones and marks secrets", () => {
    expect(new Set(workerSyncAllowlist.map((entry) => entry.name))).toEqual(
      new Set(
        workerVariableNames.filter((name) => !["NODE_ENV", "TRIGGER_SECRET_KEY"].includes(name)),
      ),
    );
    for (const { name, isSecret } of workerSyncAllowlist) {
      expect(isSecret).toBe(Object.hasOwn(providerCredentialInventory, name));
    }
    expect(workerSyncEntry("CONTENT_KEK_3")).toEqual({ isSecret: true });
    expect(workerSyncEntry("CONTENT_KEK_CURRENT")).toEqual({ isSecret: false });
    expect(workerSyncEntry("CONTENT_KEK_latest")).toBeUndefined();
    expect(workerSyncEntry("OPENAI_API_KEY")).toEqual({ isSecret: true });
    expect(workerSyncEntry("WEB_ORIGIN")).toEqual({ isSecret: false });
  });

  it("selects only allowlisted variables from a CI environment and validates them", () => {
    const deploy = productionWorkerEnv({ TRIGGER_AI_SDK_OTEL_AUTOREGISTER: undefined });
    const ci = {
      ...deploy,
      NODE_ENV: "development",
      TRIGGER_ACCESS_TOKEN: credential("tr_pat_"),
      CLOUDFLARE_D1_MIGRATE_API_TOKEN: credential(),
      GITHUB_SHA: "0123456789abcdef",
      PATH: "/usr/bin",
      EMPTY_OPTIONAL: "",
      COMPOSIO_API_KEY: "",
    };
    const synced = workerSyncEnvVars(ci);
    const names = synced.map((entry) => entry.name);
    expect(names).not.toContain("TRIGGER_SECRET_KEY");
    expect(names).not.toContain("TRIGGER_ACCESS_TOKEN");
    expect(names).not.toContain("CLOUDFLARE_D1_MIGRATE_API_TOKEN");
    expect(names).not.toContain("NODE_ENV");
    expect(names).not.toContain("GITHUB_SHA");
    expect(names).not.toContain("COMPOSIO_API_KEY");
    expect(names).toEqual([...names].sort());
    expect(synced).toContainEqual({
      name: "TRIGGER_AI_SDK_OTEL_AUTOREGISTER",
      value: "0",
      isSecret: false,
    });
    expect(synced).toContainEqual({
      name: "CONTENT_KEK_1",
      value: deploy.CONTENT_KEK_1,
      isSecret: true,
    });
    expect(synced).toContainEqual({ name: "CONTENT_KEK_CURRENT", value: "1", isSecret: false });
    expect(synced).toContainEqual({ name: "DATA_DRIVER", value: "d1", isSecret: false });
    expect(synced).toContainEqual({
      name: "OPENAI_API_KEY",
      value: deploy.OPENAI_API_KEY,
      isSecret: true,
    });
    for (const entry of synced) expect(workerSyncEntry(entry.name)).toBeDefined();
  });

  it("forces TRIGGER_AI_SDK_OTEL_AUTOREGISTER to 0 even when CI sets it otherwise", () => {
    const synced = workerSyncEnvVars(
      productionWorkerEnv({ TRIGGER_AI_SDK_OTEL_AUTOREGISTER: "1" }),
    );
    expect(synced).toContainEqual({
      name: "TRIGGER_AI_SDK_OTEL_AUTOREGISTER",
      value: "0",
      isSecret: false,
    });
  });

  it("refuses to sync an invalid or local configuration", () => {
    expect(() => workerSyncEnvVars(localWorkerEnv())).toThrow(ConfigError);
    expect(() => workerSyncEnvVars(productionWorkerEnv({ CONTENT_KEK_1: "short" }))).toThrow(
      /CONTENT_KEK_1/,
    );
  });
});
