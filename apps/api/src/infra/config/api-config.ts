import type { ApiConfig } from "@symplist/config/api";

/** Injection token for the validated, frozen {@link ApiConfig} (§16.1). */
export const API_CONFIG = "symplist:API_CONFIG";

export type { ApiConfig };

/** Whether the api runs in production, where development adapters and diagnostics are refused. */
export function isProduction(config: Pick<ApiConfig, "NODE_ENV">): boolean {
  return config.NODE_ENV === "production";
}

/**
 * Migrations run on api startup outside production, and in a local deployment (§3.4, §16.3).
 *
 * The production rule exists because a hosted deploy applies migrations as its own deliberate step: two
 * instances racing to migrate one D1 database, or a rollout silently changing a schema, are outcomes
 * worth a separate command and a human watching it.
 *
 * A local install has none of that. There is one process, one file, no operator and no deploy — and a
 * schema that nothing ever applied means the app opens to a database with no tables, which is how the
 * first boot of the desktop app offline (note 18, `DEPLOYMENT=local`) fails if this returns false.
 */
export function runsMigrationsOnStartup(
  config: Pick<ApiConfig, "NODE_ENV" | "DEPLOYMENT">,
): boolean {
  return config.NODE_ENV !== "production" || config.DEPLOYMENT === "local";
}
