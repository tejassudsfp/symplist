import { createSimonModels, runSimonTurn } from "@symplist/agent";
import { simonRunPayloadSchema } from "@symplist/contracts";
import { SimonRepository } from "@symplist/core/simon";
import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { toWorkerError, WorkerError } from "../../infra/errors.ts";
import { type WorkerRuntime, workerRuntime } from "../../infra/runtime.ts";
import { d1 } from "../../queues.ts";

/** IDs enter, enums/counts leave; all content uses D1 envelopes and the encrypted API push. */
export async function runDurableSimon(
  payload: unknown,
  runtime: WorkerRuntime,
  attempt: number,
  signal?: AbortSignal,
) {
  const parsed = simonRunPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new WorkerError("simon.payload_invalid");
  if (!runtime.config.DURABLE) return { status: "noop" as const, steps: 0 };
  const repository = new SimonRepository({
    db: runtime.db,
    keys: runtime.keys,
    now: () => Date.now(),
    policy: { betaAccessRequired: runtime.config.BETA_ACCESS_REQUIRED },
    quickChatTtlHours: runtime.config.QUICK_CHAT_TTL_HOURS,
  });
  try {
    return await runSimonTurn(parsed.data.runId, {
      repository,
      executor: "trigger",
      models: createSimonModels(runtime.config),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(890_000)])
        : AbortSignal.timeout(890_000),
      telemetryEnabled: runtime.config.AI_TELEMETRY_ENABLED,
      log: (event) =>
        runtime.logger.warn("simon.run_event", { code: event.code, runId: parsed.data.runId }),
      sink: (claim) =>
        runtime.runOutput({
          runId: claim.run.id,
          ownerId: claim.run.ownerId,
          attempt,
          accountKey: claim.key,
        }),
    });
  } catch (error) {
    throw toWorkerError(error);
  }
}

export const simonRun = task({
  id: "simon-run",
  queue: d1,
  machine: "micro",
  retry: { maxAttempts: 1 },
  ttl: "10m",
  maxDuration: 900,
  run: async (payload: unknown, { ctx, signal }) => {
    try {
      if (!simonRunPayloadSchema.safeParse(payload).success)
        throw new WorkerError("simon.payload_invalid");
      const runtime = workerRuntime();
      return await reportingD1Counters(
        runtime.d1Counters,
        { task: "simon-run", runId: ctx.run.id },
        () => runDurableSimon(payload, runtime, ctx.attempt.number, signal),
      );
    } catch (error) {
      throw new AbortTaskRunError(toWorkerError(error).code);
    }
  },
});
