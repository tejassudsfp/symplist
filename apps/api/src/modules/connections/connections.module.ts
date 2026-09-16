import { Module } from "@nestjs/common";
import { McpGrants } from "@symplist/core/mcp";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { MCP_GRANTS, McpGrantsController } from "../mcp/mcp-grants.controller.ts";
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
  ],
  providers: [
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
