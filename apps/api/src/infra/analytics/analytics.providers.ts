import type { Provider } from "@nestjs/common";
import { createServerAnalytics, type ServerAnalyticsEmitter } from "@symplist/analytics/server";
import { AppLogger } from "../../common/logging/logger.ts";
import { API_CONFIG, type ApiConfig } from "../config/api-config.ts";

/** Injection token for the api's server analytics emitter (§15). */
export const SERVER_ANALYTICS = "symplist:SERVER_ANALYTICS";

/**
 * One batched `posthog-node` emitter per process; a no-op when `ANALYTICS_ENABLED=false` or no
 * project key is configured (§15).
 *
 * Async because the client is loaded on demand: a deployment that captures nothing never pulls
 * `posthog-node` into the module graph, which is what lets an offline install (note 18) run an api that
 * does not have it installed. Nest awaits an async `useFactory`.
 */
export async function createApiAnalytics(
  config: ApiConfig,
  logger: AppLogger,
): Promise<ServerAnalyticsEmitter> {
  return await createServerAnalytics({
    enabled: config.ANALYTICS_ENABLED,
    projectKey: config.POSTHOG_PROJECT_KEY,
    ...(config.POSTHOG_HOST ? { host: config.POSTHOG_HOST } : {}),
    delivery: "batched",
    logger: { warn: (entry) => logger.warn(entry.event, { code: entry.code }) },
  });
}

export const analyticsProviders: Provider[] = [
  { provide: SERVER_ANALYTICS, useFactory: createApiAnalytics, inject: [API_CONFIG, AppLogger] },
];
