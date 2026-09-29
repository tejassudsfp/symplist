/**
 * Environment types shared by the api and worker runtimes (§16.2). The schemas that produce them are
 * in `runtime.ts`, `api.ts` and `worker.ts`; the secret inventory is in `secrets.ts` (§4.5, §16.1).
 */

export type NodeEnv = "development" | "production" | "test";
export type DataDriver = "d1" | "local";
export type EmailDriver = "resend" | "log";
/** Master keys come from environment variables behind a key provider (decision A4). */
export type KeyProviderKind = "env";

/**
 * A generated secret family: `<NAME>_<n>` values (32 random bytes, base64url) plus
 * `<NAME>_CURRENT=<n>` (§4.5).
 */
export interface SecretFamilyConfig {
  /** The version named by `<NAME>_CURRENT`. */
  readonly current: number;
  /** Every configured `<NAME>_<n>` value, keyed by version. */
  readonly versions: ReadonlyMap<number, string>;
}

/** Variables read by both the api and the worker ("both" in §16.2). */
export interface SharedRuntimeConfig {
  WEB_ORIGIN: string;
  API_ORIGIN: string;
  WS_ORIGIN: string;

  DATA_DRIVER: DataDriver;
  EMAIL_DRIVER: EmailDriver;
  DURABLE: boolean;
  KEY_PROVIDER: KeyProviderKind;

  BETA_ACCESS_REQUIRED: boolean;
  /** Billing and paywalls are out of beta scope; `true` is rejected (§16.1). */
  BILLING_ENABLED: false;
  PAYWALL_ENABLED: false;

  REMINDERS_ENABLED: boolean;
  REMINDER_EMAIL_ENABLED: boolean;
  REMINDER_MAX_LATENESS_HOURS: number;
  DEFAULT_TIMEZONE: string;
  DOC_MAX_BYTES: number;
  GIT_TMP_DIR: string;
  /**
   * Absolute directory of the `DATA_DRIVER=local` SQLite file and object store, shared by the api and
   * `trigger dev`; defaults to `<repo>/.local-data`.
   */
  LOCAL_DATA_DIR: string;

  /** Required when `DATA_DRIVER=d1`. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  D1_DATABASE_ID?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  /** Required when `EMAIL_DRIVER=resend`. */
  RESEND_API_KEY?: string;
  COMPOSIO_API_KEY?: string;

  ANALYTICS_ENABLED: boolean;
  POSTHOG_PROJECT_KEY?: string;
  POSTHOG_HOST?: string;

  CONTENT_KEK: SecretFamilyConfig;
  INTERNAL_EVENT_SECRET: SecretFamilyConfig;
  REMINDER_UNSUBSCRIBE_SECRET: SecretFamilyConfig;
}

/** Flags that enable live integration suites in tests (§16.2, §17). */
export interface LiveTestFlags {
  LIVE_D1: boolean;
  LIVE_R2: boolean;
  LIVE_TRIGGER: boolean;
  LIVE_COMPOSIO: boolean;
  LIVE_OPENAI: boolean;
  LIVE_POSTHOG: boolean;
}
