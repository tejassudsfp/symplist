import { Module } from "@nestjs/common";
import type { ServerAnalyticsEmitter } from "@symplist/analytics/server";
import { AnalyticsService } from "@symplist/core/analytics";
import type { RealtimePublisher } from "@symplist/core/events";
import { SharingGrants, SharingReader, SharingRepository } from "@symplist/core/sharing";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { SERVER_ANALYTICS } from "../../infra/analytics/analytics.providers.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { OBJECT_STORE } from "../../infra/storage/storage.providers.ts";
import { REALTIME_PUBLISHER } from "../realtime/realtime.tokens.ts";
import { ArtifactController } from "./artifact.controller.ts";
import { ArtifactAssetsController } from "./artifact-assets.controller.ts";
import { SharingController } from "./sharing.controller.ts";
import { SharingEvents } from "./sharing.events.ts";

/** The sharing feature: controllers, gateway handlers and providers live in this folder (§2.3). */
@Module({
  controllers: [SharingController, ArtifactAssetsController, ArtifactController],
  providers: [
    SharingEvents,
    {
      provide: SharingRepository,
      inject: [
        DB_CLIENT,
        OBJECT_STORE,
        KEY_PROVIDER,
        API_CONFIG,
        CLOCK,
        SERVER_ANALYTICS,
        REALTIME_PUBLISHER,
      ],
      useFactory: (
        db: DbClient,
        objects: ObjectStore,
        keys: KeyProvider,
        config: ApiConfig,
        clock: Clock,
        emitter: ServerAnalyticsEmitter,
        realtime: RealtimePublisher,
      ) => {
        const analytics = new AnalyticsService({
          db,
          policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
          enabled: emitter.enabled,
          emitter,
          now: () => clock.now(),
        });
        return new SharingRepository({
          db,
          objects,
          keys,
          policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
          now: () => clock.now(),
          artifactOrigin: config.ARTIFACT_ORIGIN,
          privateOrigins: [config.WEB_ORIGIN, config.API_ORIGIN],
          maxBytes: config.DOC_MAX_BYTES,
          onGrantChanged: (owner, taskId, artifactId) =>
            realtime.publishToUser(owner, {
              type: "share_grant.changed",
              data: { taskId, artifactId },
            }),
          onConfirmed: (owner, event, properties, id) =>
            analytics.capture(owner, event, properties, id),
        });
      },
    },
    {
      provide: SharingGrants,
      inject: [SharingRepository],
      useFactory: (repo: SharingRepository) => new SharingGrants(repo),
    },
    {
      provide: SharingReader,
      inject: [SharingRepository],
      useFactory: (repo: SharingRepository) => new SharingReader(repo),
    },
  ],
  exports: [SharingRepository, SharingGrants],
})
export class SharingModule {}
