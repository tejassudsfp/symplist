import { logger, task } from "@trigger.dev/sdk";
import { runtimeReport } from "../lib/runtime-report";

/** Confirms the worker runs and that the Git binary is available to tasks. */
export const healthcheck = task({
  id: "symplist-healthcheck",
  machine: "micro",
  maxDuration: 60,
  run: async () => {
    const report = await runtimeReport();
    logger.info("Symplist worker healthcheck", { ...report });
    return report;
  },
});
