import {
  SEARCH_INDEX_TASK_ID,
  searchIndexPayloadSchema,
  searchIndexTriggerOptions,
} from "@symplist/core/search";
import { AbortTaskRunError, idempotencyKeys, task, tasks } from "@trigger.dev/sdk";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { toWorkerError, WorkerError } from "../../infra/errors.ts";
import { workerRuntime } from "../../infra/runtime.ts";
import { d1 } from "../../queues.ts";
import { runSearchIndexTask } from "./run-search-index.ts";

/**
 * Writes an owner's search index when `DURABLE=true` (§8.8, §10.1), enqueued by producers with the
 * ids-only payload `{ ownerId }`, `idempotencyKey: search:<ownerId>:<30-second window>` and `delay: '30s'`.
 * Idempotent: every attempt loads the published generation and applies what is still pending. D1, R2 and
 * network outages are retried up to three attempts, on a larger machine after running out of memory;
 * anything else ends the run with its stable code.
 */
export const searchIndex = task({
  id: "search-index",
  queue: d1,
  machine: "micro",
  maxDuration: 300,
  retry: { maxAttempts: 3, outOfMemory: { machine: "small-1x" } },
  run: async (payload: unknown, { ctx, signal }) => {
    try {
      if (!searchIndexPayloadSchema.safeParse(payload).success) {
        throw new WorkerError("search_index.payload_invalid");
      }
      const runtime = workerRuntime();
      return await reportingD1Counters(
        runtime.d1Counters,
        { task: "search-index", runId: ctx.run.id },
        () =>
          runSearchIndexTask(
            payload,
            {
              db: runtime.db,
              objects: runtime.objects,
              keys: runtime.keys,
              accessPolicy: { betaAccessRequired: runtime.config.BETA_ACCESS_REQUIRED },
              logger: runtime.logger,
              announce: (input) => runtime.events.announce(input),
              enqueue: async (ownerId) => {
                const options = searchIndexTriggerOptions(ownerId, Date.now());
                // Raw keys are run-scoped inside a task; the window key must dedupe across runs.
                const idempotencyKey = await idempotencyKeys.create(options.idempotencyKey, {
                  scope: "global",
                });
                await tasks.trigger(
                  SEARCH_INDEX_TASK_ID,
                  { ownerId },
                  { ...options, idempotencyKey },
                );
              },
            },
            signal,
          ),
      );
    } catch (error) {
      const mapped = toWorkerError(error);
      if (!mapped.retryable) throw new AbortTaskRunError(mapped.code);
      throw mapped;
    }
  },
});
