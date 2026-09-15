import type { ExecutionJob, ExecutionKindDefinition } from "@symplist/core/events";
import {
  type ExecutionObservation,
  type ExecutionTarget,
  type Executor,
  ExecutorError,
  observeTriggerStatus,
  type StartedExecution,
  type TriggerRunsClient,
} from "./executor.ts";

const payloadKey = /^[a-z][A-Za-z0-9]{0,63}$/;
const payloadValue = /^[A-Za-z0-9._:-]{1,128}$/;

/** Throws unless a Trigger payload holds only ids and enums (§8.3). */
export function assertIdsOnlyPayload(payload: Readonly<Record<string, string>>): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ExecutorError("executor.payload_invalid", "Trigger payloads must be objects");
  }
  const entries = Object.entries(payload);
  if (entries.length === 0 || entries.length > 8) {
    throw new ExecutorError("executor.payload_invalid", "Trigger payloads carry 1 to 8 ids");
  }
  for (const [name, value] of entries) {
    if (!payloadKey.test(name) || typeof value !== "string" || !payloadValue.test(value)) {
      throw new ExecutorError(
        "executor.payload_invalid",
        "Trigger payloads carry ids and enums only",
      );
    }
  }
}

function triggerFailure(error: unknown): ExecutorError {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: unknown }).status
      : undefined;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429
    ? new ExecutorError("executor.trigger_rejected", `Trigger rejected the request (${status})`)
    : new ExecutorError("executor.trigger_unavailable", "Trigger is unavailable");
}

/**
 * Starts durable work with `tasks.trigger(<task>, <ids>, { idempotencyKey: subjectId })`, polls with
 * `runs.retrieve` and stops with `runs.cancel` (§8.1). It never runs handlers in process and never
 * triggers an intent that already has a Trigger run id.
 */
export class TriggerExecutor implements Executor {
  readonly kind = "trigger" as const;

  constructor(private readonly client: TriggerRunsClient) {}

  async start(
    job: ExecutionJob,
    definition: ExecutionKindDefinition,
    existingTriggerRunId?: string | null,
  ): Promise<StartedExecution> {
    if (existingTriggerRunId) return { executor: "trigger", triggerRunId: existingTriggerRunId };
    const payload = definition.payload(job);
    assertIdsOnlyPayload(payload);
    let handle: { readonly id: string };
    try {
      handle = await this.client.tasks.trigger(definition.triggerTaskId, payload, {
        idempotencyKey: job.subjectId,
      });
    } catch (error) {
      throw triggerFailure(error);
    }
    if (typeof handle?.id !== "string" || !payloadValue.test(handle.id)) {
      throw new ExecutorError("executor.trigger_unavailable", "Trigger returned no run id");
    }
    return { executor: "trigger", triggerRunId: handle.id };
  }

  async cancel(target: ExecutionTarget): Promise<void> {
    if (!target.triggerRunId) return;
    try {
      await this.client.runs.cancel(target.triggerRunId);
    } catch (error) {
      throw triggerFailure(error);
    }
  }

  async observe(target: ExecutionTarget): Promise<ExecutionObservation> {
    if (!target.triggerRunId) return { state: "unknown" };
    try {
      const run = await this.client.runs.retrieve(target.triggerRunId);
      return observeTriggerStatus(run.status);
    } catch (error) {
      throw triggerFailure(error);
    }
  }
}
