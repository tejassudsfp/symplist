import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  apiConfigSchema,
  apiSecretFamilies,
  apiVariableNames,
  loadApiConfig,
  parseApiConfig,
} from "./api.ts";
import { ConfigError, type ConfigIssue } from "./errors.ts";
import { credential, generatedSecret, localApiEnv, productionApiEnv } from "./testing/fixtures.ts";

function issuesOf(env: Record<string, string | undefined>): readonly ConfigIssue[] {
  const result = parseApiConfig(env);
  if (result.ok) throw new Error("expected the configuration to be invalid");
  return result.issues;
}

const issue = (variable: string, message: string | RegExp) =>
  expect.objectContaining({
    variable,
    message:
      typeof message === "string"
        ? expect.stringContaining(message)
        : expect.stringMatching(message),
  });

describe("api configuration: valid environments", () => {
  it("loads a local development environment with the documented defaults", () => {
    const env = localApiEnv();
    const config = loadApiConfig(env);
    expect(config).toMatchObject({
      NODE_ENV: "development",
      PORT: 4000,
      TRUST_PROXY_HOPS: 0,
      DATA_DRIVER: "local",
      EMAIL_DRIVER: "log",
      DURABLE: false,
      KEY_PROVIDER: "env",
      BETA_ACCESS_REQUIRED: true,
      BILLING_ENABLED: false,
      PAYWALL_ENABLED: false,
      AI_USAGE_LIMITS_ENABLED: false,
      OTP_LENGTH: 6,
      OTP_TTL_MINUTES: 10,
      OTP_MAX_ATTEMPTS: 5,
      VAULT_IDLE_LOCK_MINUTES: 5,
      REMINDERS_ENABLED: true,
      REMINDER_EMAIL_ENABLED: true,
      REMINDER_MAX_LATENESS_HOURS: 24,
      DEFAULT_TIMEZONE: "UTC",
      QUICK_CHAT_TTL_HOURS: 24,
      DOC_MAX_BYTES: 1_048_576,
      GIT_TMP_DIR: join(tmpdir(), "symplist-git"),
      AI_ENABLED: true,
      AI_DEFAULT_TIER: "fast",
      AI_FAST_PROVIDER: "openai",
      AI_FAST_MODEL: "gpt-5.6-luna",
      AI_SMART_PROVIDER: "openai",
      AI_SMART_MODEL: "gpt-5.6-terra",
      AI_PROVIDER_MODE: "live",
      AI_TELEMETRY_ENABLED: true,
      ANALYTICS_ENABLED: false,
    });
    for (const family of apiSecretFamilies) {
      expect(config[family].current).toBe(1);
      expect(config[family].versions.get(1)).toBe(env[`${family}_1`]);
    }
    expect(Object.isFrozen(config)).toBe(true);
    expect("OPENAI_API_KEY" in config).toBe(false);
  });

  it("loads a production environment in durable mode", () => {
    const config = loadApiConfig(
      productionApiEnv({ ADMIN_BOOTSTRAP_EMAIL: " Owner@Example.COM " }),
    );
    expect(config).toMatchObject({
      NODE_ENV: "production",
      PORT: 10_000,
      DATA_DRIVER: "d1",
      EMAIL_DRIVER: "resend",
      DURABLE: true,
      TRUST_PROXY_HOPS: 1,
      ADMIN_BOOTSTRAP_EMAIL: "owner@example.com",
    });
  });

  it("parses explicit values, rotated families and every provider mode", () => {
    const [v1, v2] = [generatedSecret(), generatedSecret()];
    const config = loadApiConfig(
      localApiEnv({
        CONTENT_KEK_1: v1,
        CONTENT_KEK_2: v2,
        CONTENT_KEK_CURRENT: "2",
        BETA_ACCESS_REQUIRED: "false",
        AI_DEFAULT_TIER: "smart",
        AI_FAST_PROVIDER: "bedrock",
        AI_FAST_MODEL: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        AI_PROVIDER_MODE: "scripted",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: credential("AKIA"),
        AWS_SECRET_ACCESS_KEY: credential(),
        GOOGLE_VERTEX_PROJECT: "symplist-dev",
        GOOGLE_VERTEX_LOCATION: "global",
        GOOGLE_VERTEX_CREDENTIALS_JSON: JSON.stringify({ type: "service_account" }),
        OPENAI_API_KEY: credential("sk-"),
        DEFAULT_TIMEZONE: "Asia/Kolkata",
        GIT_TMP_DIR: "/var/tmp/symplist-git",
        OTP_LENGTH: "8",
        PORT: "65535",
      }),
    );
    expect(config.CONTENT_KEK.current).toBe(2);
    expect(config.CONTENT_KEK.versions.size).toBe(2);
    expect(config.BETA_ACCESS_REQUIRED).toBe(false);
    expect(config.AI_FAST_PROVIDER).toBe("bedrock");
    expect(config.AI_PROVIDER_MODE).toBe("scripted");
    expect(config.DEFAULT_TIMEZONE).toBe("Asia/Kolkata");
    expect(config.OTP_LENGTH).toBe(8);
    expect(config.PORT).toBe(65_535);
  });

  it("treats empty values as unset", () => {
    const config = loadApiConfig(
      localApiEnv({ OPENAI_API_KEY: "", PORT: "", COMPOSIO_API_KEY: "" }),
    );
    expect(config.PORT).toBe(4000);
    expect("OPENAI_API_KEY" in config).toBe(false);
  });

  it("reads process.env by default", () => {
    for (const [name, value] of Object.entries(localApiEnv())) vi.stubEnv(name, value);
    try {
      expect(loadApiConfig().NODE_ENV).toBe("development");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("works as a Standard Schema for Nest's ConfigModule", async () => {
    const valid = await apiConfigSchema["~standard"].validate(localApiEnv());
    expect(valid.issues).toBeUndefined();
    const invalid = await apiConfigSchema["~standard"].validate(localApiEnv({ DURABLE: "yes" }));
    expect(invalid.issues).toEqual([
      expect.objectContaining({ path: ["DURABLE"], message: 'must be "true" or "false"' }),
    ]);
  });
});

describe("api configuration: field validation", () => {
  it.each([
    ["DURABLE", "1"],
    ["DURABLE", "TRUE"],
    ["DURABLE", "yes"],
    ["BETA_ACCESS_REQUIRED", " true"],
    ["ANALYTICS_ENABLED", "on"],
  ])("rejects the non-strict boolean %s=%s", (name, value) => {
    expect(issuesOf(localApiEnv({ [name]: value }))).toEqual([
      issue(name, 'must be "true" or "false"'),
    ]);
  });

  it.each(["BILLING_ENABLED", "PAYWALL_ENABLED", "AI_USAGE_LIMITS_ENABLED"])(
    "rejects %s=true and accepts false",
    (name) => {
      expect(issuesOf(localApiEnv({ [name]: "true" }))).toEqual([issue(name, "must be false")]);
      expect(parseApiConfig(localApiEnv({ [name]: "false" })).ok).toBe(true);
    },
  );

  it.each([
    ["NODE_ENV", undefined, "is required"],
    ["NODE_ENV", "staging", "must be one of: development, test, production"],
    ["DATA_DRIVER", undefined, "is required"],
    ["DATA_DRIVER", "sqlite", "must be one of"],
    ["EMAIL_DRIVER", "smtp", "must be one of"],
    ["KEY_PROVIDER", "kms", "must be one of: env"],
    ["WEB_ORIGIN", undefined, "is required"],
    ["WEB_ORIGIN", "http://localhost:3000/", "must be an origin"],
    ["API_ORIGIN", "https://api.example.com/v1", "must be an origin"],
    ["API_ORIGIN", "HTTP://LOCALHOST:4000", "must be an origin"],
    ["API_ORIGIN", "https://user:pass@api.example.com", "must be an origin"],
    ["WS_ORIGIN", "http://localhost:4000", "must be an origin such as wss://"],
    ["ARTIFACT_ORIGIN", "ftp://127.0.0.1", "must be an origin"],
    ["PORT", "0", "from 1 to 65535"],
    ["PORT", "65536", "from 1 to 65535"],
    ["PORT", "4000.0", "whole number"],
    ["PORT", "+4000", "whole number"],
    ["PORT", "04000", "whole number"],
    ["OTP_LENGTH", "4", "from 6 to 8"],
    ["OTP_TTL_MINUTES", "0", "from 1 to 60"],
    ["OTP_MAX_ATTEMPTS", "11", "from 1 to 10"],
    ["VAULT_IDLE_LOCK_MINUTES", "61", "from 1 to 60"],
    ["TRUST_PROXY_HOPS", "-1", "whole number"],
    ["REMINDER_MAX_LATENESS_HOURS", "169", "from 1 to 168"],
    ["QUICK_CHAT_TTL_HOURS", "0", "from 1 to 168"],
    ["DOC_MAX_BYTES", "2097152", "from 1024 to 1048576"],
    ["DEFAULT_TIMEZONE", "Mars/Olympus", "IANA time zone"],
    ["DEFAULT_TIMEZONE", "+05:30", "IANA time zone"],
    ["GIT_TMP_DIR", ".local-data/git", "absolute directory"],
    ["EMAIL_FROM_SECURITY", undefined, "is required"],
    ["EMAIL_FROM_SECURITY", "security at example", "email address"],
    ["EMAIL_FROM_SECURITY", "Symplist <security@example.com", "email address"],
    ["ADMIN_BOOTSTRAP_EMAIL", "not-an-email", "must be an email address"],
    ["AI_DEFAULT_TIER", "turbo", "must be one of: fast, smart"],
    ["AI_FAST_PROVIDER", "gateway", "must be one of"],
    ["AI_SMART_MODEL", "gpt 5", "model id"],
    ["AI_PROVIDER_MODE", "mock", "must be one of: live, scripted"],
    ["OPENAI_API_KEY", "sk-with space-1234", "single-line credential"],
    ["OPENAI_API_KEY", "short", "single-line credential"],
    ["OPENAI_API_KEY", '"sk-quoted-12345"', "single-line credential"],
    ["GOOGLE_VERTEX_CREDENTIALS_JSON", "[1,2]", "JSON object"],
    ["CLOUDFLARE_ACCOUNT_ID", "ACCOUNT", "Cloudflare account id"],
    ["D1_DATABASE_ID", "db-1", "D1 database id"],
    ["R2_BUCKET", "Bucket_1", "R2 bucket name"],
    ["TRIGGER_SECRET_KEY", "sk_live_abcdefgh", "Trigger.dev secret key"],
    ["TRIGGER_PROJECT_REF", "project", "project ref"],
    ["POSTHOG_PROJECT_ID", "abc", "numeric PostHog project id"],
    ["AWS_REGION", "US-EAST-1", "AWS region"],
  ])("reports %s=%j", (name, value, message) => {
    expect(issuesOf(localApiEnv({ [name]: value }))).toContainEqual(issue(name, message));
  });
});

describe("api configuration: cross-field rules (§16.1)", () => {
  it.each([
    ["DATA_DRIVER", "local", "must be d1 when NODE_ENV=production"],
    ["EMAIL_DRIVER", "log", "must be resend when NODE_ENV=production"],
    ["AI_PROVIDER_MODE", "scripted", "must be live when NODE_ENV=production"],
    ["WEB_ORIGIN", "http://symplist.example.com", "must use https when NODE_ENV=production"],
    ["API_ORIGIN", "http://api.symplist.example.com", "must use https when NODE_ENV=production"],
    ["WS_ORIGIN", "ws://api.symplist.example.com", "must use wss when NODE_ENV=production"],
    [
      "ARTIFACT_ORIGIN",
      "http://share.symplist.example.com",
      "must use https when NODE_ENV=production",
    ],
    ["TRUST_PROXY_HOPS", undefined, "is required when NODE_ENV=production"],
    ["POSTHOG_HOST", "http://localhost:8000", "must not be a loopback host"],
  ])("production refuses %s=%j", (name, value, message) => {
    expect(issuesOf(productionApiEnv({ [name]: value }))).toContainEqual(issue(name, message));
  });

  it("production refusing local drivers reports both drivers and needs no hosted credentials", () => {
    const issues = issuesOf(productionApiEnv({ DATA_DRIVER: "local", EMAIL_DRIVER: "log" }));
    expect(issues.map((entry) => entry.variable)).toEqual(["DATA_DRIVER", "EMAIL_DRIVER"]);
  });

  it.each([
    "CLOUDFLARE_ACCOUNT_ID",
    "D1_DATABASE_ID",
    "CLOUDFLARE_D1_API_TOKEN",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ])("DATA_DRIVER=d1 requires %s", (name) => {
    expect(issuesOf(productionApiEnv({ [name]: undefined }))).toEqual([
      issue(name, "is required when DATA_DRIVER=d1"),
    ]);
  });

  it("EMAIL_DRIVER=resend requires RESEND_API_KEY", () => {
    expect(issuesOf(productionApiEnv({ RESEND_API_KEY: undefined }))).toEqual([
      issue("RESEND_API_KEY", "is required when EMAIL_DRIVER=resend"),
    ]);
  });

  it.each(["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_REF"])("DURABLE=true requires %s", (name) => {
    expect(issuesOf(productionApiEnv({ [name]: undefined }))).toEqual([
      issue(name, "is required when DURABLE=true"),
    ]);
  });

  it("DURABLE=false requires the reminder sender and ignores Trigger settings", () => {
    expect(issuesOf(localApiEnv({ EMAIL_FROM_REMINDERS: undefined }))).toEqual([
      issue("EMAIL_FROM_REMINDERS", "is required when DURABLE=false"),
    ]);
    expect(parseApiConfig(localApiEnv({ TRIGGER_SECRET_KEY: credential("tr_dev_") })).ok).toBe(
      true,
    );
  });

  it.each([
    "OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "GOOGLE_VERTEX_CREDENTIALS_JSON",
    "TOGETHER_API_KEY",
  ])("DURABLE=true rejects the AI provider credential %s on the api", (name) => {
    const value =
      name === "GOOGLE_VERTEX_CREDENTIALS_JSON" ? '{"type":"service_account"}' : credential();
    const extra = name.startsWith("AWS_")
      ? {
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: credential(),
          AWS_SECRET_ACCESS_KEY: credential(),
        }
      : name.startsWith("GOOGLE_")
        ? { GOOGLE_VERTEX_PROJECT: "symplist-prod", GOOGLE_VERTEX_LOCATION: "global" }
        : {};
    expect(issuesOf(productionApiEnv({ ...extra, [name]: value }))).toContainEqual(
      issue(name, "must not be set on the api when DURABLE=true"),
    );
  });

  it.each([
    "CLOUDFLARE_D1_WORKER_API_TOKEN",
    "CLOUDFLARE_D1_MIGRATE_API_TOKEN",
    "TRIGGER_ACCESS_TOKEN",
  ])("rejects %s on the api", (name) => {
    expect(issuesOf(localApiEnv({ [name]: credential() }))).toEqual([
      issue(name, "must not be set on the api"),
    ]);
  });

  it("requires complete AI provider credential groups", () => {
    expect(issuesOf(localApiEnv({ AWS_ACCESS_KEY_ID: credential() }))).toEqual([
      issue("AWS_REGION", "Amazon Bedrock"),
      issue("AWS_SECRET_ACCESS_KEY", "Amazon Bedrock"),
    ]);
    expect(
      issuesOf(localApiEnv({ GOOGLE_VERTEX_CREDENTIALS_JSON: '{"type":"service_account"}' })),
    ).toEqual([
      issue("GOOGLE_VERTEX_LOCATION", "GOOGLE_VERTEX_CREDENTIALS_JSON is set"),
      issue("GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_CREDENTIALS_JSON is set"),
    ]);
  });

  it("requires PostHog deletion credentials when analytics can capture", () => {
    expect(
      issuesOf(
        productionApiEnv({ POSTHOG_PERSONAL_API_KEY: undefined, POSTHOG_PROJECT_ID: undefined }),
      ),
    ).toEqual([
      issue("POSTHOG_PERSONAL_API_KEY", "account deletion must delete PostHog data"),
      issue("POSTHOG_PROJECT_ID", "account deletion must delete PostHog data"),
    ]);
    expect(issuesOf(productionApiEnv({ POSTHOG_HOST: undefined }))).toEqual([
      issue("POSTHOG_HOST", "is required when ANALYTICS_ENABLED=true"),
    ]);
    expect(issuesOf(localApiEnv({ POSTHOG_PERSONAL_API_KEY: credential("phx_") }))).toEqual([
      issue("POSTHOG_PROJECT_ID", "is required when POSTHOG_PERSONAL_API_KEY is set"),
    ]);
    expect(issuesOf(localApiEnv({ POSTHOG_HOST: "http://posthog.example.com" }))).toEqual([
      issue("POSTHOG_HOST", "must use https"),
    ]);
    expect(
      parseApiConfig(
        productionApiEnv({
          ANALYTICS_ENABLED: "false",
          POSTHOG_PERSONAL_API_KEY: undefined,
          POSTHOG_PROJECT_ID: undefined,
        }),
      ).ok,
    ).toBe(true);
  });

  it("keeps the share host and the WebSocket gateway on the right hosts", () => {
    expect(issuesOf(localApiEnv({ ARTIFACT_ORIGIN: "http://localhost:4001" }))).toEqual([
      issue("ARTIFACT_ORIGIN", "different host from API_ORIGIN"),
      issue("ARTIFACT_ORIGIN", "different host from WEB_ORIGIN"),
    ]);
    expect(issuesOf(localApiEnv({ WS_ORIGIN: "ws://localhost:4001" }))).toEqual([
      issue("WS_ORIGIN", "same host and port as API_ORIGIN"),
    ]);
  });
});

describe("api configuration: secret families and equal values (§4.5)", () => {
  it.each([...apiSecretFamilies])("requires the %s family", (family) => {
    expect(
      issuesOf(localApiEnv({ [`${family}_1`]: undefined, [`${family}_CURRENT`]: undefined })),
    ).toEqual([issue(`${family}_CURRENT`, "is required")]);
  });

  it("requires every family value to decode to 32 bytes", () => {
    expect(
      issuesOf(
        localApiEnv({ MCP_OAUTH_SIGNING_KEY_1: Buffer.from("a".repeat(16)).toString("base64url") }),
      ),
    ).toEqual([issue("MCP_OAUTH_SIGNING_KEY_1", "32 random bytes")]);
  });

  it("rejects any two equal secrets across families and provider credentials", () => {
    const shared = generatedSecret();
    const issues = issuesOf(
      productionApiEnv({
        CONTENT_KEK_1: shared,
        IDEMPOTENCY_SECRET_1: shared,
        RESEND_WEBHOOK_SECRET: shared,
      }),
    );
    expect(issues).toEqual([
      issue("IDEMPOTENCY_SECRET_1", "must not reuse the value of CONTENT_KEK_1"),
      issue("RESEND_WEBHOOK_SECRET", "must not reuse the value of CONTENT_KEK_1"),
    ]);
    const token = credential();
    expect(
      issuesOf(productionApiEnv({ R2_ACCESS_KEY_ID: token, CLOUDFLARE_D1_API_TOKEN: token })),
    ).toEqual([issue("R2_ACCESS_KEY_ID", "must not reuse the value of CLOUDFLARE_D1_API_TOKEN")]);
  });
});

describe("api configuration: error reporting never echoes values", () => {
  it("names every invalid variable and never includes a submitted value", () => {
    const marker = "LEAKMARKER";
    const env: Record<string, string> = {};
    for (const name of apiVariableNames) env[name] = `${marker}-${name.toLowerCase()} value`;
    for (const family of apiSecretFamilies) {
      env[`${family}_1`] = `${marker}${family}`.padEnd(43, "x");
      env[`${family}_CURRENT`] = `${marker}1`;
      env[family] = `${marker}-unversioned`;
    }
    env.CLOUDFLARE_D1_WORKER_API_TOKEN = `${marker}-worker-token`;
    let error: unknown;
    try {
      loadApiConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.runtime).toBe("api");
    expect(configError.message).not.toContain(marker);
    expect(JSON.stringify(configError.issues)).not.toContain(marker);
    const variables = new Set(configError.issues.map((entry) => entry.variable));
    for (const name of apiVariableNames) expect(variables).toContain(name);
    for (const family of apiSecretFamilies) {
      expect(variables).toContain(family);
      expect(variables).toContain(`${family}_1`);
      expect(variables).toContain(`${family}_CURRENT`);
    }
    expect(variables).toContain("CLOUDFLARE_D1_WORKER_API_TOKEN");
    expect(configError.message).toMatch(/^Invalid api configuration \(\d+ problems\):\n- /);
  });

  it("never echoes a valid secret that is duplicated or held by the wrong runtime", async () => {
    const secret = generatedSecret();
    const env = productionApiEnv({
      SESSION_DIGEST_SECRET_1: secret,
      OTP_DIGEST_SECRET_1: secret,
      OPENAI_API_KEY: secret,
      CLOUDFLARE_D1_MIGRATE_API_TOKEN: secret,
    });
    const error = (() => {
      try {
        loadApiConfig(env);
      } catch (caught) {
        return caught as ConfigError;
      }
      throw new Error("expected a ConfigError");
    })();
    expect(error.message).not.toContain(secret);
    const standard = await apiConfigSchema["~standard"].validate(env);
    expect(JSON.stringify(standard.issues)).not.toContain(secret);
    expect(JSON.stringify(standard)).not.toContain(secret);
  });
});
