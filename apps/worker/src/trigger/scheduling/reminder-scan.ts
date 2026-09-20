import { AbortTaskRunError, schedules } from "@trigger.dev/sdk";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { toWorkerError } from "../../infra/errors.ts";
import { workerRuntime } from "../../infra/runtime.ts";
import { runScheduledWork } from "../../infra/scheduling-runtime.ts";
import { reminderScan } from "../../queues.ts";

export const reminderScanTask = schedules.task({
  id: "reminder-scan",
  cron: { pattern: "0,15,30 * * * *", timezone: "UTC", environments: ["PRODUCTION", "STAGING"] },
  ttl: "10m",
  queue: reminderScan,
  machine: "micro",
  maxDuration: 300,
  retry: { maxAttempts: 2 },
  run: async (_payload, { ctx, signal }) => {
    try {
      const runtime = workerRuntime();
      return await reportingD1Counters(
        runtime.d1Counters,
        { task: "reminder-scan", runId: ctx.run.id },
        () => runScheduledWork(runtime, "scan", signal),
      );
    } catch (error) {
      const mapped = toWorkerError(error);
      if (!mapped.retryable) throw new AbortTaskRunError(mapped.code);
      throw mapped;
    }
  },
});
