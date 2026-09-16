import { Module } from "@nestjs/common";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { ConnectionsController } from "./connections.controller.ts";
import { CONNECTIONS_RUNTIME, createConnectionsRuntime } from "./connections.runtime.ts";

/** The connections feature: controllers, gateway handlers and providers live in this folder (§2.3). */
@Module({
  controllers: [ConnectionsController],
  providers: [
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
