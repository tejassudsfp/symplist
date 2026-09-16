import { AbortTaskRunError, schedules } from "@trigger.dev/sdk";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { toWorkerError } from "../../infra/errors.ts";
import { workerRuntime } from "../../infra/runtime.ts";
import { d1 } from "../../queues.ts";
import { runScheduledWork } from "./runtime.ts";

export const cleanupHourlyTask = schedules.task({
  id: "cleanup-hourly",
  cron: { pattern: "5 * * * *", timezone: "UTC", environments: ["PRODUCTION", "STAGING"] },
  ttl: "30m",
  queue: d1,
  machine: "micro",
  maxDuration: 300,
  retry: { maxAttempts: 2 },
  run: async (_payload, { ctx, signal }) => {
    try {
      const runtime = workerRuntime();
      return await reportingD1Counters(
        runtime.d1Counters,
        { task: "cleanup-hourly", runId: ctx.run.id },
        () => runScheduledWork(runtime, "cleanup", signal),
      );
    } catch (error) {
      const mapped = toWorkerError(error);
      if (!mapped.retryable) throw new AbortTaskRunError(mapped.code);
      throw mapped;
    }
  },
});
