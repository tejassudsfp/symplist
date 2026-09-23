import type { ServerAnalyticsEmitter } from "@symplist/analytics/server";
import { AiKeyStore } from "@symplist/core/ai";
import { AnalyticsService } from "@symplist/core/analytics";
import { createSimonConnectionAuthority } from "@symplist/core/connections";
import type { DocumentTools } from "@symplist/core/documents";
import type { LocalExecutionHandler } from "@symplist/core/events";
import type { SimonRepository } from "@symplist/core/simon";
import { resolveClaimedVaultArguments } from "@symplist/core/vault";
import type { ObjectStore } from "@symplist/storage";
import type { AppLogger } from "../../common/logging/logger.ts";
import type { ApiConfig } from "../../infra/config/api-config.ts";
import type { TopicHub } from "../realtime/topic-hub.ts";
import type { SimonConnectionsRuntime } from "./simon.connections.ts";

/** The durable API never even imports the model/tool package through this path. */
export function createLocalSimonHandler(
  repository: SimonRepository,
  config: ApiConfig,
  hub: TopicHub,
  logger: AppLogger,
  documents: DocumentTools,
  objects: ObjectStore,
  emitter: ServerAnalyticsEmitter,
  connections: SimonConnectionsRuntime,
): LocalExecutionHandler {
  const aiKeys = new AiKeyStore({
    ...repository.options,
    defaults: {
      fast: { provider: config.AI_FAST_PROVIDER, model: config.AI_FAST_MODEL },
      smart: { provider: config.AI_SMART_PROVIDER, model: config.AI_SMART_MODEL },
    },
    now: () => Date.now(),
  });
  return async (job, context) => {
    if (config.DURABLE) throw new Error("simon.local_disabled");
    const analytics = new AnalyticsService({
      ...repository.options,
      emitter,
      enabled: emitter.enabled,
    });
    const {
      createSimonModels,
      runSimonTurn,
      simonApprovedConnectionEffect,
      simonConnectionTools,
      simonNativeTools,
      simonSharingTools,
    } = await import("@symplist/agent");
    let connectionOptions:
      | { runId: string; value: Parameters<typeof simonConnectionTools>[1] }
      | undefined;
    const connectionsFor = (
      toolContext: Parameters<typeof simonApprovedConnectionEffect>[0],
    ): Parameters<typeof simonConnectionTools>[1] => {
      if (connectionOptions?.runId === toolContext.claim.run.id) return connectionOptions.value;
      const authority = createSimonConnectionAuthority(
        repository,
        toolContext.claim,
        connections.schema,
      );
      let external: ReturnType<typeof connections.tools> | undefined;
      const value = {
        authority,
        external: () => (external ??= connections.tools(authority)),
        resolveArguments: (toolSlug: string, args: Readonly<Record<string, unknown>>) =>
          resolveClaimedVaultArguments(repository, toolContext.claim, toolSlug, args),
      };
      connectionOptions = { runId: toolContext.claim.run.id, value };
      return value;
    };
    await runSimonTurn(job.subjectId, {
      repository,
      executor: "local",
      models: createSimonModels(config, {
        // The key belongs to the account the run belongs to (§8.6). Read per run and not retained.
        credentials: (ownerId, tier) => aiKeys.credentialFor(ownerId, tier),
      }),
      signal: context.signal,
      telemetryEnabled: config.AI_TELEMETRY_ENABLED,
      approvedEffect: (toolContext) =>
        simonApprovedConnectionEffect(toolContext, connectionsFor(toolContext)),
      connectedToolkits: async (toolContext) =>
        (await connectionsFor(toolContext).authority.connections()).map((entry) => entry.toolkit),
      documents: () => ({ tools: documents, git: null }),
      tools: async (toolContext) => ({
        ...simonConnectionTools(toolContext, connectionsFor(toolContext)),
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
          onConfirmed: (ownerId, event, properties, eventId) =>
            analytics.capture(ownerId, event, properties, eventId),
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
