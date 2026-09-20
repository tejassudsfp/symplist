import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from "@nestjs/common";
import {
  DocumentMaintenance,
  DocumentRepository,
  DocumentService,
  DocumentTools,
  GrantRetrievalBudgets,
} from "@symplist/core/documents";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { GitService, type PublicationHooks } from "@symplist/docs";
import type { ObjectStore } from "@symplist/storage";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { DOCUMENT_GIT } from "../../infra/documents/git.module.ts";
import { LocalScheduler } from "../../infra/scheduler/local-scheduler.ts";
import { OBJECT_STORE } from "../../infra/storage/storage.providers.ts";
import { InternalEventHandlerRegistry } from "../internal/internal-event-handlers.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { TopicRegistry } from "../realtime/topic-registry.ts";
import { DocumentsController } from "./documents.controller.ts";
import {
  documentHeadChangedHandler,
  documentHeadsContributor,
  RealtimeDocumentEvents,
} from "./documents.realtime.ts";

/** The api's Git service: at most 2 concurrent reconstructions (§9.1). */
export { DOCUMENT_GIT } from "../../infra/documents/git.module.ts";
/** Optional publication hooks, bound only by tests to stop a publication at a crash point. */
export const DOCUMENT_PUBLICATION_HOOKS = "symplist:DOCUMENT_PUBLICATION_HOOKS";

/** Minute past each UTC hour the local scheduler runs document maintenance (after cleanup at :05). */
export const DOCUMENT_MAINTENANCE_MINUTE = 35;

/**
 * Registers the documents feature with the runtime: the `user` snapshot heads, the worker's head
 * announcements, hourly maintenance in local mode, and the startup sweep of Git temp directories a
 * crashed process left behind (§9.1).
 */
@Injectable()
export class DocumentsLifecycle implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(TopicHub) private readonly hub: TopicHub,
    @Inject(TopicRegistry) private readonly topics: TopicRegistry,
    @Inject(InternalEventHandlerRegistry) private readonly internal: InternalEventHandlerRegistry,
    @Inject(LocalScheduler) private readonly scheduler: LocalScheduler,
    @Inject(DOCUMENT_GIT) private readonly git: GitService,
    @Inject(DocumentMaintenance) private readonly maintenance: DocumentMaintenance,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.topics.registerUserSnapshotContributor(documentHeadsContributor(this.db));
    this.internal.register(documentHeadChangedHandler({ db: this.db, hub: this.hub }));
    this.scheduler.registerHourlyJob({
      name: "documents-maintenance",
      minute: DOCUMENT_MAINTENANCE_MINUTE,
      run: async (context) => {
        const result = await this.maintenance.run({ now: this.clock.now() });
        this.logger.info("documents.maintenance_ran", {
          generation: context.generation,
          deletedBundles: result.orphans.deletedBundles,
          deletedSnapshots: result.orphans.deletedSnapshots,
          deletedJobs: result.orphans.deletedJobs,
          staleWorkspaces: result.staleWorkspaces,
          expiredRequests: result.expiredRequests,
          expiredReceipts: result.expiredReceipts,
          complete: result.orphans.complete,
        });
      },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.git.available) {
      this.logger.error("documents.git_unavailable");
      return;
    }
    try {
      const removed = await this.git.sweepStaleWorkspaces(Date.now());
      if (removed > 0) this.logger.warn("documents.stale_workspaces_removed", { count: removed });
    } catch (error) {
      this.logger.warn("documents.workspace_sweep_failed", { error });
    }
  }
}

/** The documents feature: controllers, gateway handlers and providers live in this folder (§2.3). */
@Module({
  controllers: [DocumentsController],
  providers: [
    {
      provide: RealtimeDocumentEvents,
      inject: [TopicHub, AppLogger],
      useFactory: (hub: TopicHub, logger: AppLogger) => new RealtimeDocumentEvents(hub, logger),
    },
    { provide: DOCUMENT_PUBLICATION_HOOKS, useValue: null },
    {
      provide: DocumentRepository,
      inject: [
        DB_CLIENT,
        OBJECT_STORE,
        KEY_PROVIDER,
        DOCUMENT_GIT,
        API_CONFIG,
        CLOCK,
        RealtimeDocumentEvents,
        DOCUMENT_PUBLICATION_HOOKS,
      ],
      useFactory: (
        db: DbClient,
        objects: ObjectStore,
        keys: KeyProvider,
        git: GitService,
        config: ApiConfig,
        clock: Clock,
        events: RealtimeDocumentEvents,
        hooks: PublicationHooks | null,
      ) =>
        new DocumentRepository({
          db,
          objects,
          keys,
          git,
          accessPolicy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
          now: () => clock.now(),
          docMaxBytes: config.DOC_MAX_BYTES,
          events,
          ...(hooks ? { publication: { hooks } } : {}),
        }),
    },
    {
      provide: DocumentService,
      inject: [DocumentRepository],
      useFactory: (repository: DocumentRepository) => new DocumentService(repository),
    },
    {
      provide: DocumentTools,
      inject: [DocumentRepository],
      useFactory: (repository: DocumentRepository) => new DocumentTools(repository),
    },
    {
      provide: GrantRetrievalBudgets,
      inject: [CLOCK],
      useFactory: (clock: Clock) => new GrantRetrievalBudgets({ now: () => clock.now() }),
    },
    {
      provide: DocumentMaintenance,
      inject: [DB_CLIENT, OBJECT_STORE, DOCUMENT_GIT],
      useFactory: (db: DbClient, objects: ObjectStore, git: GitService) =>
        new DocumentMaintenance({ db, objects, git }),
    },
    DocumentsLifecycle,
  ],
  exports: [DocumentRepository, DocumentService, DocumentTools, GrantRetrievalBudgets],
})
export class DocumentsModule {}
