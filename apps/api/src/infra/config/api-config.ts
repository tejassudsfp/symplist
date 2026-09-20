import type { ApiConfig } from "@symplist/config/api";

/** Injection token for the validated, frozen {@link ApiConfig} (§16.1). */
export const API_CONFIG = "symplist:API_CONFIG";

export type { ApiConfig };

/** Whether the api runs in production, where development adapters and diagnostics are refused. */
export function isProduction(config: Pick<ApiConfig, "NODE_ENV">): boolean {
  return config.NODE_ENV === "production";
}

/** Migrations run on api startup only outside production (§3.4, §16.3). */
export function runsMigrationsOnStartup(config: Pick<ApiConfig, "NODE_ENV">): boolean {
  return config.NODE_ENV !== "production";
}
