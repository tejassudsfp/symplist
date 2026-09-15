import type { AiProviderCredentials, SharedRuntimeConfig } from "./shared.ts";

/**
 * Validated worker (Trigger.dev) configuration: every worker and "both" variable in §16.2. The worker
 * never holds the api-only secret families, webhook secrets or the api D1 token (§4.5).
 */
export interface WorkerConfig extends SharedRuntimeConfig, AiProviderCredentials {
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
