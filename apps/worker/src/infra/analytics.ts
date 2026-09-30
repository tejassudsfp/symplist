import { createServerAnalytics } from "@symplist/analytics/server";
import { AnalyticsService } from "@symplist/core/analytics";
import type { WorkerRuntime } from "./runtime.ts";

type AnalyticsRuntime = Pick<WorkerRuntime, "db" | "logger"> & {
  readonly config: Pick<
    WorkerRuntime["config"],
    "ANALYTICS_ENABLED" | "POSTHOG_PROJECT_KEY" | "POSTHOG_HOST" | "BETA_ACCESS_REQUIRED"
  >;
};
const services = new WeakMap<AnalyticsRuntime, Promise<AnalyticsService>>();

/**
 * One emitter per runtime; consent is re-read for every confirmed action, delivery is bounded.
 *
 * The promise rather than the service is cached, so two concurrent callers share one emitter instead of
 * racing to build two — `createServerAnalytics` loads `posthog-node` on demand now, and an await is a
 * window for a second caller to slip through.
 */
export function workerAnalytics(runtime: AnalyticsRuntime): Promise<AnalyticsService> {
  const existing = services.get(runtime);
  if (existing) return existing;
  const built = build(runtime);
  services.set(runtime, built);
  return built;
}

async function build(runtime: AnalyticsRuntime): Promise<AnalyticsService> {
  const emitter = await createServerAnalytics({
    enabled: runtime.config.ANALYTICS_ENABLED,
    projectKey: runtime.config.POSTHOG_PROJECT_KEY,
    ...(runtime.config.POSTHOG_HOST ? { host: runtime.config.POSTHOG_HOST } : {}),
    delivery: "immediate",
    logger: { warn: (entry) => runtime.logger.warn(entry.event, { code: entry.code }) },
  });
  return new AnalyticsService({
    db: runtime.db,
    policy: { betaAccessRequired: runtime.config.BETA_ACCESS_REQUIRED },
    now: () => Date.now(),
    enabled: emitter.enabled,
    emitter,
  });
}
