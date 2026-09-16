import type { DocumentTools } from "@symplist/core/documents";
import type { LocalExecutionHandler } from "@symplist/core/events";
import type { SimonRepository } from "@symplist/core/simon";
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
): LocalExecutionHandler {
  return async (job, context) => {
    if (config.DURABLE) throw new Error("simon.local_disabled");
    const { createSimonModels, runSimonTurn } = await import("@symplist/agent");
    await runSimonTurn(job.subjectId, {
      repository,
      executor: "local",
      models: createSimonModels(config),
      signal: context.signal,
      telemetryEnabled: config.AI_TELEMETRY_ENABLED,
      documents: () => ({ tools: documents, git: null }),
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
