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

/** How long the api waits for a woken session to attach a run before giving up on the session. */
const SESSION_WAKE_ATTEMPTS = 5;
const SESSION_WAKE_INTERVAL_MS = 120;

export interface TriggerExecutorOptions {
  /**
   * `SIMON_CHAT_SESSIONS`: route a kind that declares a session task to `sessions.start` instead of
   * `tasks.trigger`, so a follow-up inside the idle window answers from a parked run rather than
   * paying a cold boot. Off leaves every dispatch exactly as it was.
   */
  readonly sessions?: boolean;
  /** Overridden in tests so waking a session does not spend real time. */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Starts durable work with `tasks.trigger(<task>, <ids>, { idempotencyKey: subjectId })`, polls with
 * `runs.retrieve` and stops with `runs.cancel` (§8.1). It never runs handlers in process and never
 * triggers an intent that already has a Trigger run id.
 *
 * With sessions enabled a kind that declares one starts through `sessions.start` instead. That call
 * is idempotent on the session's external id and returns the run it triggered or found, so the run
 * id recorded on the intent, and therefore observe and cancel, are unchanged.
 */
export class TriggerExecutor implements Executor {
  readonly kind = "trigger" as const;

  constructor(
    private readonly client: TriggerRunsClient,
    private readonly options: TriggerExecutorOptions = {},
  ) {}

  private pause(ms: number): Promise<void> {
    return this.options.wait
      ? this.options.wait(ms)
      : new Promise((resolve) => setTimeout(resolve, ms));
  }

  async start(
    job: ExecutionJob,
    definition: ExecutionKindDefinition,
    existingTriggerRunId?: string | null,
  ): Promise<StartedExecution> {
    if (existingTriggerRunId) return { executor: "trigger", triggerRunId: existingTriggerRunId };
    const session = this.sessionFor(job, definition);
    const runId = session
      ? await this.startSession(session)
      : await this.startTask(job, definition);
    if (!payloadValue.test(runId)) {
      throw new ExecutorError("executor.trigger_unavailable", "Trigger returned no run id");
    }
    return { executor: "trigger", triggerRunId: runId };
  }

  /** The session this job runs in, or undefined when it dispatches as a plain task. */
  private sessionFor(
    job: ExecutionJob,
    definition: ExecutionKindDefinition,
  ): { readonly taskIdentifier: string; readonly externalId: string } | undefined {
    if (!this.options.sessions || definition.sessionTaskId === undefined) return undefined;
    const externalId = definition.sessionExternalId?.(job) ?? null;
    if (externalId === null) return undefined;
    return { taskIdentifier: definition.sessionTaskId, externalId };
  }

  private async startSession(session: {
    readonly taskIdentifier: string;
    readonly externalId: string;
  }): Promise<string> {
    // `basePayload` is fixed when the session is created and replayed for every later run of it, so
    // it names the conversation the session spans and never this turn's run; the task reads the run
    // it must execute from D1. `chat.agent`'s wire payload calls that conversation `chatId`.
    const basePayload = { chatId: session.externalId };
    assertIdsOnlyPayload(basePayload);
    try {
      const started = await this.client.sessions.start({
        type: "chat.agent",
        externalId: session.externalId,
        taskIdentifier: session.taskIdentifier,
        triggerConfig: { basePayload },
      });
      const runId = typeof started?.runId === "string" ? started.runId : "";
      // A session created by this call has a run, and it is this turn's. A session that already
      // existed is the ambiguous case: `sessions.start` is documented to trigger only the first
      // run, so what comes back may be a run that finished turns ago. Rather than trust either
      // reading, ask whether it is still alive — and wake the session when it is not.
      if (!started?.isCached) return runId;
      if (runId !== "" && (await this.stillRunning(runId))) return runId;
      return await this.wakeSession(session.externalId);
    } catch (error) {
      throw triggerFailure(error);
    }
  }

  /** Whether a run can still take this turn, treating an unreadable one as finished. */
  private async stillRunning(runId: string): Promise<boolean> {
    try {
      const run = await this.client.runs.retrieve(runId);
      return observeTriggerStatus(run.status).state === "active";
    } catch {
      return false;
    }
  }

  /**
   * Hands a turn to a session whose run has already gone.
   *
   * Appending to a session's input is what boots a continuation, and it is the only thing that
   * does: a fresh `sessions.start` is idempotent and starts nothing for a session that exists. The
   * record carries the conversation id and nothing else — the task resolves the run it must execute
   * from D1, so no message content needs to cross, and none does.
   *
   * The append answers with nothing, so the run is read back. It appears within a beat of the
   * append, but not always within the same instant.
   */
  private async wakeSession(externalId: string): Promise<string> {
    const wake = { chatId: externalId, trigger: "submit-message" } as const;
    assertIdsOnlyPayload(wake);
    await this.client.sessions.append(externalId, { kind: "message", payload: wake });
    for (let attempt = 0; attempt < SESSION_WAKE_ATTEMPTS; attempt += 1) {
      const runId = await this.client.sessions.currentRunId(externalId);
      if (runId !== null && runId !== "" && (await this.stillRunning(runId))) return runId;
      await this.pause(SESSION_WAKE_INTERVAL_MS);
    }
    throw new ExecutorError(
      "executor.trigger_unavailable",
      "The chat session did not start a run for this turn",
    );
  }

  private async startTask(job: ExecutionJob, definition: ExecutionKindDefinition): Promise<string> {
    const payload = definition.payload(job);
    assertIdsOnlyPayload(payload);
    try {
      const handle = await this.client.tasks.trigger(definition.triggerTaskId, payload, {
        idempotencyKey: job.subjectId,
      });
      return typeof handle?.id === "string" ? handle.id : "";
    } catch (error) {
      throw triggerFailure(error);
    }
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
