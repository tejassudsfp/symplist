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
