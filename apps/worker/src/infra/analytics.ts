import { createServerAnalytics } from "@symplist/analytics/server";
import { AnalyticsService } from "@symplist/core/analytics";
import type { WorkerRuntime } from "./runtime.ts";

type AnalyticsRuntime = Pick<WorkerRuntime, "db" | "logger"> & {
  readonly config: Pick<
    WorkerRuntime["config"],
    "ANALYTICS_ENABLED" | "POSTHOG_PROJECT_KEY" | "POSTHOG_HOST" | "BETA_ACCESS_REQUIRED"
  >;
};
const services = new WeakMap<AnalyticsRuntime, AnalyticsService>();

/** One emitter per runtime; consent is re-read for every confirmed action, delivery is bounded. */
export function workerAnalytics(runtime: AnalyticsRuntime): AnalyticsService {
  const existing = services.get(runtime);
  if (existing) return existing;
  const emitter = createServerAnalytics({
    enabled: runtime.config.ANALYTICS_ENABLED,
    projectKey: runtime.config.POSTHOG_PROJECT_KEY,
    ...(runtime.config.POSTHOG_HOST ? { host: runtime.config.POSTHOG_HOST } : {}),
    delivery: "immediate",
    logger: { warn: (entry) => runtime.logger.warn(entry.event, { code: entry.code }) },
  });
  const service = new AnalyticsService({
    db: runtime.db,
    policy: { betaAccessRequired: runtime.config.BETA_ACCESS_REQUIRED },
    now: () => Date.now(),
    enabled: emitter.enabled,
    emitter,
  });
  services.set(runtime, service);
  return service;
}
