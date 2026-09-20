import {
  createSimonModels,
  runSimonTurn,
  simonNativeTools,
  simonSharingTools,
} from "@symplist/agent";
import { simonRunPayloadSchema } from "@symplist/contracts";
import { DocumentRepository, DocumentTools, DurableDocumentGit } from "@symplist/core/documents";
import { SimonRepository } from "@symplist/core/simon";
import { GitService } from "@symplist/docs";
import { AbortTaskRunError, task, tasks } from "@trigger.dev/sdk";
import { workerAnalytics } from "../../infra/analytics.ts";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { toWorkerError, WorkerError } from "../../infra/errors.ts";
import { type WorkerRuntime, workerRuntime } from "../../infra/runtime.ts";
import { simonTaskAnnouncements } from "../../infra/simon-events.ts";
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
  const flushAnnouncements = simonTaskAnnouncements(runtime);
  try {
    return await runSimonTurn(parsed.data.runId, {
      repository,
      executor: "trigger",
      models: createSimonModels(runtime.config),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(890_000)])
        : AbortSignal.timeout(890_000),
      telemetryEnabled: runtime.config.AI_TELEMETRY_ENABLED,
      tools: async (context) => ({
        ...simonNativeTools(context, {
          scheduling: {
            remindersEnabled: runtime.config.REMINDERS_ENABLED,
            emailEnabled: runtime.config.REMINDER_EMAIL_ENABLED,
            defaultZone: runtime.config.DEFAULT_TIMEZONE,
          },
          onScheduleChanged: async (ownerId, taskId, version) => {
            await runtime.events.announce({
              type: "schedule.changed",
              ownerId,
              payload: { taskId, version },
            });
          },
        }),
        ...simonSharingTools(context, {
          objects: runtime.objects,
          privateOrigins: [runtime.config.WEB_ORIGIN, runtime.config.API_ORIGIN],
          maxBytes: runtime.config.DOC_MAX_BYTES,
          onConfirmed: (ownerId, event, properties, eventId) =>
            workerAnalytics(runtime).capture(ownerId, event, properties, eventId),
          onGrantChanged: async (ownerId, taskId, artifactId) => {
            await runtime.events.announce({
              type: "share_grant.changed",
              ownerId,
              payload: { taskId, artifactId },
            });
          },
        }),
      }),
      documents: () => {
        const documents = new DocumentRepository({
          db: runtime.db,
          objects: runtime.objects,
          keys: runtime.keys,
          git: new GitService({
            tempDir: runtime.config.GIT_TMP_DIR,
            runner: async () => {
              throw new WorkerError("simon.git_forbidden");
            },
          }),
          accessPolicy: { betaAccessRequired: runtime.config.BETA_ACCESS_REQUIRED },
          now: () => Date.now(),
          docMaxBytes: runtime.config.DOC_MAX_BYTES,
        });
        return {
          tools: new DocumentTools(documents),
          git: new DurableDocumentGit({
            artifacts: documents.artifacts,
            now: () => Date.now(),
            triggerAndWait: (taskId, input, options) =>
              tasks.triggerAndWait(taskId, input, options),
          }),
        };
      },
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
  } finally {
    await flushAnnouncements();
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
