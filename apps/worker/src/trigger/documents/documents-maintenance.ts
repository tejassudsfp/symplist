import { AbortTaskRunError, schedules } from "@trigger.dev/sdk";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { toWorkerError } from "../../infra/errors.ts";
import { workerRuntime } from "../../infra/runtime.ts";
import { d1 } from "../../queues.ts";
import { documentWorkerFor } from "./document-git.ts";
import { runDocumentsMaintenanceTask } from "./documents-runtime.ts";

/**
 * Hourly document maintenance when `DURABLE=true` (§8.8 cleanup, §9.2): Git temp sweeps, orphaned
 * bundle, snapshot and job object collection after the grace period, and expired request and receipt
 * clean-up, in bounded passes. The api's local scheduler runs the same service when `DURABLE=false`.
 * It never fires in development.
 */
export const documentsMaintenance = schedules.task({
  id: "documents-maintenance",
  cron: { pattern: "35 * * * *", timezone: "UTC", environments: ["PRODUCTION", "STAGING"] },
  queue: d1,
  machine: "micro",
  ttl: "30m",
  maxDuration: 600,
  retry: { maxAttempts: 2 },
  run: async (_payload, { ctx }) => {
    try {
      const runtime = workerRuntime();
      return await reportingD1Counters(
        runtime.d1Counters,
        { task: "documents-maintenance", runId: ctx.run.id },
        () => runDocumentsMaintenanceTask(documentWorkerFor(runtime)),
      );
    } catch (error) {
      const mapped = toWorkerError(error);
      if (!mapped.retryable) throw new AbortTaskRunError(mapped.code);
      throw mapped;
    }
  },
});
