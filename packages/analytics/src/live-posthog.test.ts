import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createServerAnalytics, type ServerAnalyticsLogEntry } from "./server.ts";

interface LivePostHogSettings {
  readonly projectKey: string;
  readonly host: string;
}

function livePostHogSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly settings: LivePostHogSettings } | { readonly skipReason: string } {
  if (env.LIVE_POSTHOG !== "1") {
    return { skipReason: "set LIVE_POSTHOG=1 to run the live PostHog contract" };
  }
  const missing = [
    env.POSTHOG_PROJECT_KEY ? undefined : "POSTHOG_PROJECT_KEY",
    env.POSTHOG_HOST ? undefined : "POSTHOG_HOST",
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    return { skipReason: `LIVE_POSTHOG=1 but ${missing.join(", ")} missing` };
  }
  return {
    settings: {
      projectKey: env.POSTHOG_PROJECT_KEY as string,
      host: env.POSTHOG_HOST as string,
    },
  };
}

const live = livePostHogSettings();

if ("settings" in live) {
  describe("live PostHog ingestion contract", () => {
    it("accepts one synthetic allowlisted event through the production emitter", async () => {
      const logs: ServerAnalyticsLogEntry[] = [];
      const analytics = createServerAnalytics({
        enabled: true,
        projectKey: live.settings.projectKey,
        host: live.settings.host,
        delivery: "immediate",
        immediateTimeoutMs: 10_000,
        requestTimeoutMs: 8_000,
        fetchRetryCount: 0,
        logger: { warn: (entry) => logs.push(entry) },
      });
      try {
        await expect(
          analytics.capture({
            subject: { consent: "granted", analyticsId: randomUUID() },
            event: "task_created",
            properties: { source: "user", collection: "unclassified", is_subtask: false },
            eventId: randomUUID(),
          }),
        ).resolves.toEqual({ status: "sent" });
        expect(logs).toEqual([]);
      } finally {
        await analytics.shutdown();
      }
    }, 20_000);
  });
} else {
  describe.skip(`live PostHog contract (skipped: ${live.skipReason})`, () => {
    it("sends an allowlisted synthetic event", () => {});
  });
}
