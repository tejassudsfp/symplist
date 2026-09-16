import { Module } from "@nestjs/common";
import { SharingGrants, SharingReader, SharingRepository } from "@symplist/core/sharing";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { OBJECT_STORE } from "../../infra/storage/storage.providers.ts";
import { ArtifactController } from "./artifact.controller.ts";
import { SharingController } from "./sharing.controller.ts";

/** The sharing feature: controllers, gateway handlers and providers live in this folder (§2.3). */
@Module({
  controllers: [SharingController, ArtifactController],
  providers: [
    {
      provide: SharingRepository,
      inject: [DB_CLIENT, OBJECT_STORE, KEY_PROVIDER, API_CONFIG, CLOCK],
      useFactory: (
        db: DbClient,
        objects: ObjectStore,
        keys: KeyProvider,
        config: ApiConfig,
        clock: Clock,
      ) =>
        new SharingRepository({
          db,
          objects,
          keys,
          policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
          now: () => clock.now(),
          artifactOrigin: config.ARTIFACT_ORIGIN,
          maxBytes: config.DOC_MAX_BYTES,
        }),
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
