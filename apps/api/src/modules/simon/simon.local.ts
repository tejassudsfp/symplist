import type { DocumentTools } from "@symplist/core/documents";
import type { LocalExecutionHandler } from "@symplist/core/events";
import type { SimonRepository } from "@symplist/core/simon";
import type { ObjectStore } from "@symplist/storage";
import type { AppLogger } from "../../common/logging/logger.ts";
import type { ApiConfig } from "../../infra/config/api-config.ts";
import type { TopicHub } from "../realtime/topic-hub.ts";

/** The durable API never even imports the model/tool package through this path. */
export function createLocalSimonHandler(
  repository: SimonRepository,
  config: ApiConfig,
  hub: TopicHub,
  logger: AppLogger,
  documents: DocumentTools,
  objects: ObjectStore,
): LocalExecutionHandler {
  return async (job, context) => {
    if (config.DURABLE) throw new Error("simon.local_disabled");
    const { createSimonModels, runSimonTurn, simonNativeTools, simonSharingTools } = await import(
      "@symplist/agent"
    );
    await runSimonTurn(job.subjectId, {
      repository,
      executor: "local",
      models: createSimonModels(config),
      signal: context.signal,
      telemetryEnabled: config.AI_TELEMETRY_ENABLED,
      documents: () => ({ tools: documents, git: null }),
      tools: async (toolContext) => ({
        ...simonNativeTools(toolContext, {
          scheduling: {
            remindersEnabled: config.REMINDERS_ENABLED,
            emailEnabled: config.REMINDER_EMAIL_ENABLED,
            defaultZone: config.DEFAULT_TIMEZONE,
          },
          onScheduleChanged: async (ownerId, taskId, version) => {
            await hub.publishToUser(ownerId, {
              type: "schedule.changed",
              data: { taskId, version },
            });
          },
        }),
        ...simonSharingTools(toolContext, {
          objects,
          privateOrigins: [config.WEB_ORIGIN, config.API_ORIGIN],
          maxBytes: config.DOC_MAX_BYTES,
          onGrantChanged: (ownerId, taskId, artifactId) =>
            hub.publishToUser(ownerId, {
              type: "share_grant.changed",
              data: { taskId, artifactId },
            }),
        }),
      }),
      log: (event) => logger.warn("simon.run_event", { code: event.code, runId: job.subjectId }),
      sink: (claim) => ({
        write: async (chunk) => {
          await hub.publishToConversation(
            { conversationId: claim.run.conversationId, ownerId: claim.run.ownerId },
            {
              type: "chunk",
              data: { runId: claim.run.id, chunk },
            },
          );
        },
        flush: async () => {},
        close: async () => {},
      }),
    });
  };
}
