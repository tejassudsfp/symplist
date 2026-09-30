import { describe, expect, it } from "vitest";
import { apiSecretFamilies, apiVariableNames } from "./api.ts";
import { liveTestFlagNames } from "./live.ts";
import { webVariableNames } from "./web.ts";
import { workerSecretFamilies, workerVariableNames } from "./worker.ts";

/**
 * The §16.2 table written out independently of the schemas, so removing or renaming a variable in a
 * schema fails here instead of silently shrinking the configuration. "Both" rows appear in both lists.
 */
const both = [
  "WEB_ORIGIN",
  "API_ORIGIN",
  "WS_ORIGIN",
  "DEPLOYMENT",
  "DATA_DRIVER",
  "EMAIL_DRIVER",
  "DURABLE",
  "KEY_PROVIDER",
  "BETA_ACCESS_REQUIRED",
  "BILLING_ENABLED",
  "PAYWALL_ENABLED",
  "REMINDERS_ENABLED",
  "REMINDER_EMAIL_ENABLED",
  "REMINDER_MAX_LATENESS_HOURS",
  "DEFAULT_TIMEZONE",
  "DOC_MAX_BYTES",
  "GIT_TMP_DIR",
  "LOCAL_DATA_DIR",
  // TRIGGER_SECRET_KEY: api; worker (platform-injected).
  "TRIGGER_SECRET_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "D1_DATABASE_ID",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "RESEND_API_KEY",
  "ANALYTICS_ENABLED",
  "POSTHOG_PROJECT_KEY",
  "POSTHOG_HOST",
  // EMAIL_FROM_REMINDERS: worker (api when DURABLE=false).
  "EMAIL_FROM_REMINDERS",
];

const apiOnly = [
  "NODE_ENV",
  "PORT",
  "ARTIFACT_ORIGIN",
  "ADMIN_BOOTSTRAP_EMAIL",
  "LOCAL_OWNER_TOKEN",
  "TRUST_PROXY_HOPS",
  "OTP_LENGTH",
  "OTP_TTL_MINUTES",
  "OTP_MAX_ATTEMPTS",
  "VAULT_IDLE_LOCK_MINUTES",
  "EMAIL_FROM_SECURITY",
  "TRIGGER_PROJECT_REF",
  "CLOUDFLARE_D1_API_TOKEN",
  "RESEND_WEBHOOK_SECRET",
  "POSTHOG_PERSONAL_API_KEY",
  "POSTHOG_PROJECT_ID",
];

const workerOnly = [
  "TRIGGER_AI_SDK_OTEL_AUTOREGISTER",
  "CLOUDFLARE_D1_WORKER_API_TOKEN",
  // Not in the §16.2 worker rows: added so the worker can refuse local drivers in production (C1.5).
  "NODE_ENV",
];

const sorted = (names: readonly string[]) => [...names].sort();

describe("§16.2 variable coverage", () => {
  it("the api schema reads exactly the api and both rows", () => {
    expect(sorted(apiVariableNames)).toEqual(sorted([...both, ...apiOnly]));
    expect(sorted(apiSecretFamilies)).toEqual(
      sorted([
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
      ]),
    );
  });

  it("the worker schema reads exactly the worker and both rows", () => {
    expect(sorted(workerVariableNames)).toEqual(sorted([...both, ...workerOnly]));
    expect(sorted(workerSecretFamilies)).toEqual(
      sorted(["CONTENT_KEK", "INTERNAL_EVENT_SECRET", "REMINDER_UNSUBSCRIBE_SECRET"]),
    );
  });

  it("the web and test schemas read exactly their rows", () => {
    expect(sorted(webVariableNames)).toEqual(
      sorted([
        "NEXT_PUBLIC_API_URL",
        "NEXT_PUBLIC_WS_URL",
        "NEXT_PUBLIC_POSTHOG_KEY",
        "NEXT_PUBLIC_POSTHOG_HOST",
        "ENABLE_EXPERIMENTAL_COREPACK",
      ]),
    );
    expect(sorted(liveTestFlagNames)).toEqual(
      sorted(["LIVE_D1", "LIVE_R2", "LIVE_TRIGGER", "LIVE_POSTHOG"]),
    );
  });
});
