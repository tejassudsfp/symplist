import { sql } from "@symplist/db";
import { AbortTaskRunError, schedules } from "@trigger.dev/sdk";
import { connectionReconcilerFor } from "../../infra/connections-runtime.ts";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { toWorkerError } from "../../infra/errors.ts";
import { workerRuntime } from "../../infra/runtime.ts";
import { d1 } from "../../queues.ts";

/** No user content enters Trigger payloads, outputs, tags, metadata or errors. */
export const connectionsReconcile = schedules.task({
  id: "connections-reconcile",
  cron: { pattern: "20 3 * * *", timezone: "UTC", environments: ["PRODUCTION", "STAGING"] },
  queue: d1,
  machine: "micro",
  ttl: "1h",
  maxDuration: 3600,
  retry: { maxAttempts: 2 },
  run: async (_payload, { ctx, signal }) => {
    try {
      const runtime = workerRuntime();
      return await reportingD1Counters(
        runtime.d1Counters,
        { task: "connections-reconcile", runId: ctx.run.id },
        async () => {
          const state = await runtime.db.first(
            sql("SELECT mode, generation FROM executor_state WHERE id = 1"),
          );
          if (state?.mode !== "durable") return { status: "stale" as const };
          const reconciler = connectionReconcilerFor(runtime);
          if (!reconciler) return { status: "disabled" as const };
          return {
            status: "completed" as const,
            ...(await reconciler.run(
              { mode: "durable", generation: Number(state.generation) },
              signal,
            )),
          };
        },
      );
    } catch (error) {
      const mapped = toWorkerError(error);
      if (!mapped.retryable) throw new AbortTaskRunError(mapped.code);
      throw mapped;
    }
  },
});
