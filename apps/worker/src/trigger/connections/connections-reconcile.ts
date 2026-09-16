import { ComposioSessions, ConnectionReconciler } from "@symplist/core/connections";
import { SimonRepository } from "@symplist/core/simon";
import { sql } from "@symplist/db";
import {
  ComposioLifecycleProvider,
  createComposioClient,
  executionClient,
} from "@symplist/integrations";
import { AbortTaskRunError, schedules } from "@trigger.dev/sdk";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { toWorkerError } from "../../infra/errors.ts";
import { type WorkerRuntime, workerRuntime } from "../../infra/runtime.ts";
import { d1 } from "../../queues.ts";

export function connectionReconcilerFor(runtime: WorkerRuntime): ConnectionReconciler | null {
  if (!runtime.config.COMPOSIO_API_KEY) return null;
  const client = createComposioClient(runtime.config.COMPOSIO_API_KEY);
  const provider = new ComposioLifecycleProvider(client, runtime.config.COMPOSIO_API_KEY);
  const policy = { betaAccessRequired: runtime.config.BETA_ACCESS_REQUIRED };
  const repository = new SimonRepository({
    db: runtime.db,
    keys: runtime.keys,
    now: Date.now,
    policy,
    quickChatTtlHours: runtime.config.QUICK_CHAT_TTL_HOURS,
  });
  const sessions = new ComposioSessions({
    db: runtime.db,
    client: executionClient(client),
    policy,
    now: Date.now,
  });
  return new ConnectionReconciler({
    repository,
    provider,
    sessions,
    changed: async (ownerId, connectionId) => {
      await runtime.events.announce({
        type: "connection.status_changed",
        ownerId,
        payload: { connectionId },
      });
    },
  });
}

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
