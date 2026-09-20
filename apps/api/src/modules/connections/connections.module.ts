import { Module } from "@nestjs/common";
import type { ServerAnalyticsEmitter } from "@symplist/analytics/server";
import { DocumentRepository } from "@symplist/core/documents";
import { McpGrants } from "@symplist/core/mcp";
import { SchedulingService } from "@symplist/core/scheduling";
import { createSearchSources, SearchIndexCache, SearchQueryService } from "@symplist/core/search";
import { SharingRepository } from "@symplist/core/sharing";
import { SimonRepository } from "@symplist/core/simon";
import { TaskService } from "@symplist/core/tasks";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { GitService } from "@symplist/docs";
import type { ObjectStore } from "@symplist/storage";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { SERVER_ANALYTICS } from "../../infra/analytics/analytics.providers.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { DOCUMENT_GIT } from "../../infra/documents/git.module.ts";
import { ExecutionDispatcher } from "../../infra/executors/dispatcher.ts";
import { OBJECT_STORE } from "../../infra/storage/storage.providers.ts";
import { McpController } from "../mcp/mcp.controller.ts";
import { McpRegistration } from "../mcp/mcp.registration.ts";
import { mcpFeatureExtensions } from "../mcp/mcp-extensions.ts";
import { MCP_GRANTS, McpGrantsController } from "../mcp/mcp-grants.controller.ts";
import { MCP_TOOLS, McpTools } from "../mcp/mcp-tools.ts";
import { OAuthConsentController, OAuthController } from "../mcp/oauth.controller.ts";
import { OAUTH_RUNTIME, OAuthRuntime } from "../mcp/oauth.runtime.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { ComposioWebhookController } from "./composio-webhook.controller.ts";
import { ConnectionsController } from "./connections.controller.ts";
import { ConnectionsRegistration } from "./connections.registration.ts";
import { CONNECTIONS_RUNTIME, createConnectionsRuntime } from "./connections.runtime.ts";

/** The connections feature: controllers, gateway handlers and providers live in this folder (§2.3). */
@Module({
  controllers: [
    ConnectionsController,
    ComposioWebhookController,
    McpGrantsController,
    OAuthController,
    OAuthConsentController,
    McpController,
  ],
  providers: [
    McpRegistration,
    {
      provide: MCP_TOOLS,
      inject: [
        MCP_GRANTS,
        OBJECT_STORE,
        DOCUMENT_GIT,
        API_CONFIG,
        TopicHub,
        ExecutionDispatcher,
        SERVER_ANALYTICS,
      ],
      useFactory: (
        grants: McpGrants,
        objects: ObjectStore,
        git: GitService,
        config: ApiConfig,
        hub: TopicHub,
        dispatcher: ExecutionDispatcher,
        analytics: ServerAnalyticsEmitter,
      ) =>
        new McpTools(
          grants,
          new TaskService(grants.options),
          new DocumentRepository({
            ...grants.options,
            objects,
            git,
            accessPolicy: grants.options.policy,
            docMaxBytes: config.DOC_MAX_BYTES,
            events: {
              headChanged: async (event) => {
                await hub.publishToUser(event.ownerId, {
                  type: "document.head_changed",
                  data: {
                    taskId: event.taskId,
                    revision: event.revision,
                    author: event.author,
                    changedSectionIds: event.changedSectionIds.slice(0, 100),
                  },
                });
              },
            },
          }),
          new SearchQueryService({
            ...grants.options,
            objects,
            sources: createSearchSources({ ...grants.options, objects }),
            cache: new SearchIndexCache({ now: grants.options.now, maxBytes: 8 * 1024 * 1024 }),
          }),
          new SimonRepository({
            ...grants.options,
            quickChatTtlHours: config.QUICK_CHAT_TTL_HOURS,
          }),
          () => dispatcher.kick(),
          mcpFeatureExtensions(
            grants,
            new SchedulingService({
              ...grants.options,
              remindersEnabled: config.REMINDERS_ENABLED,
              emailEnabled: config.REMINDER_EMAIL_ENABLED,
              defaultZone: config.DEFAULT_TIMEZONE,
              deliveryTracking: Boolean(config.RESEND_WEBHOOK_SECRET),
            }),
            new SharingRepository({
              ...grants.options,
              objects,
              artifactOrigin: config.ARTIFACT_ORIGIN,
              privateOrigins: [config.WEB_ORIGIN, config.API_ORIGIN],
              maxBytes: config.DOC_MAX_BYTES,
              onGrantChanged: (owner, taskId, artifactId) =>
                hub.publishToUser(owner, {
                  type: "share_grant.changed",
                  data: { taskId, artifactId },
                }),
            }),
          ),
          async (result) => {
            if (!result.analytics) return;
            const { subject, event, eventId } = result.analytics;
            await analytics.capture({
              subject,
              event: event.event,
              properties: event.properties,
              eventId,
            } as Parameters<ServerAnalyticsEmitter["capture"]>[0]);
          },
        ),
    },
    {
      provide: OAUTH_RUNTIME,
      inject: [MCP_GRANTS, API_CONFIG],
      useFactory: (grants: McpGrants, config: ApiConfig) =>
        new OAuthRuntime(grants, config.API_ORIGIN),
    },
    {
      provide: MCP_GRANTS,
      inject: [DB_CLIENT, KEY_PROVIDER, CLOCK, API_CONFIG],
      useFactory: (db: DbClient, keys: KeyProvider, clock: Clock, config: ApiConfig) =>
        new McpGrants({
          db,
          keys,
          now: () => clock.now(),
          policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
        }),
    },
    ConnectionsRegistration,
    {
      provide: CONNECTIONS_RUNTIME,
      inject: [DB_CLIENT, KEY_PROVIDER, CLOCK, API_CONFIG, TopicHub],
      useFactory: (
        db: DbClient,
        keys: KeyProvider,
        clock: Clock,
        config: ApiConfig,
        hub: TopicHub,
      ) =>
        createConnectionsRuntime(db, keys, clock, config, async (owner, connectionId) => {
          await hub.publishToUser(owner, {
            type: "connection.status_changed",
            data: { connectionId },
          });
        }),
    },
  ],
})
export class ConnectionsModule {}
