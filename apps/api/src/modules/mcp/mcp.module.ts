import { Module } from "@nestjs/common";
import type { ServerAnalyticsEmitter } from "@symplist/analytics/server";
import { DocumentRepository } from "@symplist/core/documents";
import { McpGrants } from "@symplist/core/mcp";
import { SchedulingService } from "@symplist/core/scheduling";
import { createSearchSources, SearchIndexCache, SearchQueryService } from "@symplist/core/search";
import { SharingRepository } from "@symplist/core/sharing";
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
import { OBJECT_STORE } from "../../infra/storage/storage.providers.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { McpController } from "./mcp.controller.ts";
import { McpRegistration } from "./mcp.registration.ts";
import { mcpFeatureExtensions } from "./mcp-extensions.ts";
import { MCP_GRANTS, McpGrantsController } from "./mcp-grants.controller.ts";
import { MCP_TOOLS, McpTools } from "./mcp-tools.ts";
import { OAuthConsentController, OAuthController } from "./oauth.controller.ts";
import { OAUTH_RUNTIME, OAuthRuntime } from "./oauth.runtime.ts";

/**
 * The MCP feature: controllers and providers live in this folder (§2.3).
 *
 * This is how an assistant reaches Symplist, and since note 18 it is the *only* way: the workspace
 * publishes its tools here — tasks, the document outline and its sections, history, search — and the
 * agent is whichever MCP client the person already uses. `OAuthController` is what makes that a link
 * rather than a token to paste: dynamic client registration, an authorize endpoint and a consent
 * screen, so connecting is a browser round trip the owner approves.
 *
 * It used to be registered by `ConnectionsModule`, which also carried the Composio connector layer.
 * That layer existed so a server-side agent could act on the owner's behalf elsewhere; with no agent on
 * the server there was nothing to gate and nothing calling a connector, and the person's own client
 * brings better integrations than we could. So the module is MCP's own now.
 */
@Module({
  controllers: [McpGrantsController, OAuthController, OAuthConsentController, McpController],
  providers: [
    McpRegistration,
    {
      provide: MCP_TOOLS,
      inject: [MCP_GRANTS, OBJECT_STORE, DOCUMENT_GIT, API_CONFIG, TopicHub, SERVER_ANALYTICS],
      useFactory: (
        grants: McpGrants,
        objects: ObjectStore,
        git: GitService,
        config: ApiConfig,
        hub: TopicHub,
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
  ],
})
export class McpModule {}
