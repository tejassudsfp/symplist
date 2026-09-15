import { task } from "@trigger.dev/sdk";
import { createWorkerLogger } from "../infra/logger.ts";
import { runtimeReport } from "../lib/runtime-report.ts";

/**
 * Confirms the worker runs and that the Git binary is available to tasks. It uses no D1, so it
 * declares no D1 family queue; its output holds runtime facts only (§8.3).
 */
export const healthcheck = task({
  id: "symplist-healthcheck",
  machine: "micro",
  maxDuration: 60,
  retry: { maxAttempts: 1 },
  run: async () => {
    const report = await runtimeReport();
    createWorkerLogger().info("worker.healthcheck", {
      hasGit: report.git !== null,
      rssBytes: report.rssMb * 1024 * 1024,
    });
    return report;
  },
});
