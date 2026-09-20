import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { type DbClient, sql } from "@symplist/db";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { LocalScheduler } from "../../infra/scheduler/local-scheduler.ts";
import { InternalEventHandlerRegistry } from "../internal/internal-event-handlers.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { CONNECTIONS_RUNTIME, type ConnectionsRuntime } from "./connections.runtime.ts";

@Injectable()
export class ConnectionsRegistration implements OnModuleInit {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(CONNECTIONS_RUNTIME) private readonly runtime: ConnectionsRuntime,
    @Inject(LocalScheduler) private readonly scheduler: LocalScheduler,
    @Inject(InternalEventHandlerRegistry) private readonly events: InternalEventHandlerRegistry,
    @Inject(TopicHub) private readonly hub: TopicHub,
  ) {}

  onModuleInit(): void {
    this.scheduler.registerHourlyJob({
      name: "connections-reconcile",
      minute: 20,
      run: async ({ generation, scheduledFor, signal }) => {
        if (!this.runtime.enabled || new Date(scheduledFor).getUTCHours() !== 3) return;
        await this.runtime.reconciler.run({ mode: "local", generation }, signal);
      },
    });
    this.scheduler.registerHourlyJob({
      name: "connections-revocation-cleanup",
      minute: 5,
      run: async ({ generation }) => {
        if (this.runtime.enabled)
          await this.runtime.reconciler.drain({ mode: "local", generation });
      },
    });
    this.events.register({
      type: "connection.status_changed",
      handle: async (event) => {
        const connectionId = event.payload.connectionId;
        if (typeof connectionId !== "string") return;
        const row = await this.db.first(
          sql("SELECT id FROM connections WHERE id = :id AND owner_id = :owner", {
            id: connectionId,
            owner: event.ownerId,
          }),
        );
        if (row)
          await this.hub.publishToUser(event.ownerId, {
            type: "connection.status_changed",
            data: { connectionId },
          });
      },
    });
  }
}
