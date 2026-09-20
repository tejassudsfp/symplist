import { documentGitPayloadSchema } from "@symplist/contracts";
import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { toWorkerError, WorkerError } from "../../infra/errors.ts";
import { type WorkerRuntime, workerRuntime } from "../../infra/runtime.ts";
import { d1Git } from "../../queues.ts";
import {
  createDocumentWorker,
  type DocumentWorker,
  runDocumentGitTask,
} from "./documents-runtime.ts";

let worker: DocumentWorker | undefined;

/** The document services of this task process, created once from the worker runtime. */
export function documentWorkerFor(runtime: WorkerRuntime): DocumentWorker {
  worker ??= createDocumentWorker({
    db: runtime.db,
    objects: runtime.objects,
    keys: runtime.keys,
    logger: runtime.logger,
    events: runtime.events,
    config: runtime.config,
  });
  return worker;
}

/**
 * Git-backed document tools for Simon when `DURABLE=true` (§8.8, §9.1, decision R6). `simon-run`
 * triggers it with `triggerAndWait`, `idempotencyKey` = the tool call id and the ids-only payload
 * `{runId, toolCallId, taskId, op}`; the operation input and result are encrypted job objects. It has
 * its own `d1-git` queue so the waiting run never holds the slot this child needs, runs on small-1x
 * and retries once on a larger machine after running out of memory. Publications are idempotent by
 * tool call id, so a retried attempt never publishes twice.
 */
export const documentGit = task({
  id: "document-git",
  queue: d1Git,
  machine: "small-1x",
  maxDuration: 300,
  retry: { maxAttempts: 2, outOfMemory: { machine: "medium-1x" } },
  run: async (payload: unknown, { ctx }) => {
    try {
      if (!documentGitPayloadSchema.safeParse(payload).success) {
        throw new WorkerError("document_git.payload_invalid");
      }
      const runtime = workerRuntime();
      return await reportingD1Counters(
        runtime.d1Counters,
        { task: "document-git", runId: ctx.run.id },
        () => runDocumentGitTask(payload, documentWorkerFor(runtime)),
      );
    } catch (error) {
      const mapped = toWorkerError(error);
      if (!mapped.retryable) throw new AbortTaskRunError(mapped.code);
      throw mapped;
    }
  },
});
