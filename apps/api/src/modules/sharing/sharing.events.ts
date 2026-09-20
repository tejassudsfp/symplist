import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { RealtimePublisher } from "@symplist/core/events";
import { SharingError, SharingRepository } from "@symplist/core/sharing";
import { sql } from "@symplist/db";
import { InternalEventHandlerRegistry } from "../internal/internal-event-handlers.ts";
import { REALTIME_PUBLISHER } from "../realtime/realtime.tokens.ts";

@Injectable()
export class SharingEvents implements OnModuleInit {
  constructor(
    @Inject(SharingRepository) private readonly repository: SharingRepository,
    @Inject(InternalEventHandlerRegistry) private readonly internal: InternalEventHandlerRegistry,
    @Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher,
  ) {}
  onModuleInit() {
    this.internal.register({
      type: "share_grant.changed",
      handle: async (event) => {
        if (typeof event.payload.artifactId !== "string") return;
        const access = this.repository.access(event.ownerId);
        const row = await this.repository.options.db.first(
          sql(
            `SELECT id, task_id FROM artifacts WHERE id = :artifact AND owner_id = :owner
           AND deleted_at IS NULL AND ${access.sql}`,
            { ...access.params, artifact: event.payload.artifactId, owner: event.ownerId },
          ),
        );
        if (!row) throw new SharingError("not_found");
        await this.realtime.publishToUser(event.ownerId, {
          type: "share_grant.changed",
          data: { taskId: String(row.task_id), artifactId: String(row.id) },
        });
      },
    });
  }
}
