import { AbortTaskRunError, runs, task } from "@trigger.dev/sdk";
import { accountPurgePayloadSchema, runAccountPurgeTask } from "../infra/account-purge.ts";
import { toWorkerError, WorkerError } from "../infra/errors.ts";
import { workerRuntime } from "../infra/runtime.ts";
import { d1 } from "../queues.ts";

/**
 * Runs the account purge when `DURABLE=true` (§5.6, §8.8), triggered by the api dispatcher with
 * `idempotencyKey` = the user id and the ids-only payload `{ userId }`. It is idempotent: every
 * attempt resumes from `account_deletions.steps_done`. Failures that a later attempt can overcome
 * (D1, R2 or Trigger unavailable, an unfinished purge) are retried up to five attempts, on a larger
 * machine after running out of memory; anything else ends the run at once with its stable code.
 */
export const accountPurge = task({
  id: "account-purge",
  queue: d1,
  machine: "micro",
  maxDuration: 900,
  retry: { maxAttempts: 5, outOfMemory: { machine: "small-1x" } },
  run: async (payload: unknown, { signal }) => {
    try {
      if (!accountPurgePayloadSchema.safeParse(payload).success) {
        throw new WorkerError("account_purge.payload_invalid");
      }
      const runtime = workerRuntime();
      return await runAccountPurgeTask(
        payload,
        { db: runtime.db, objects: runtime.objects, runs, logger: runtime.logger },
        signal,
      );
    } catch (error) {
      const mapped = toWorkerError(error);
      if (!mapped.retryable) throw new AbortTaskRunError(mapped.code);
      throw mapped;
    }
  },
});
