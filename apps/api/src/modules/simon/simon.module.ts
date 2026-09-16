import { Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import type { ServerAnalyticsEmitter } from "@symplist/analytics/server";
import { AnalyticsService } from "@symplist/core/analytics";
import { DocumentRepository, DocumentTools } from "@symplist/core/documents";
import { SimonQuickChats, SimonRepository } from "@symplist/core/simon";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { GitService } from "@symplist/docs";
import type { ObjectStore } from "@symplist/storage";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { SERVER_ANALYTICS } from "../../infra/analytics/analytics.providers.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { DOCUMENT_GIT } from "../../infra/documents/git.module.ts";
import { ExecutionRegistry } from "../../infra/executors/execution-registry.ts";
import { OBJECT_STORE } from "../../infra/storage/storage.providers.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { SimonApprovalsController } from "./simon.approvals.controller.ts";
import { SimonController } from "./simon.controller.ts";
import { createLocalSimonHandler } from "./simon.local.ts";
import { SimonUserAsksController } from "./simon.pauses.controller.ts";
import { SimonTopics } from "./simon.realtime.ts";

@Injectable()
export class SimonLifecycle implements OnModuleInit {
  constructor(
    @Inject(SimonRepository) private readonly repository: SimonRepository,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(ExecutionRegistry) private readonly registry: ExecutionRegistry,
    @Inject(TopicHub) private readonly hub: TopicHub,
    @Inject(DocumentTools) private readonly documents: DocumentTools,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    private readonly logger: AppLogger,
  ) {}
  onModuleInit(): void {
    if (!this.config.DURABLE)
      this.registry.registerLocalHandler(
        "simon_run",
        createLocalSimonHandler(
          this.repository,
          this.config,
          this.hub,
          this.logger,
          this.documents,
          this.objects,
        ),
      );
  }
}

/** The simon feature: controllers, gateway handlers and providers live in this folder (§2.3). */
@Module({
  controllers: [SimonController, SimonUserAsksController, SimonApprovalsController],
  providers: [
    {
      provide: SimonQuickChats,
      inject: [SimonRepository, API_CONFIG, SERVER_ANALYTICS],
      useFactory: (
        repository: SimonRepository,
        config: ApiConfig,
        emitter: ServerAnalyticsEmitter,
      ) => {
        const analytics = new AnalyticsService({
          ...repository.options,
          emitter,
          enabled: config.ANALYTICS_ENABLED && Boolean(config.POSTHOG_PROJECT_KEY),
        });
        return new SimonQuickChats(repository, async (owner, collection, eventId) => {
          await analytics.capture(owner, "quick_chat_saved", { collection }, eventId);
          await analytics.capture(
            owner,
            "task_created",
            { collection, source: "quick_chat", is_subtask: false },
            repository.nextId(),
          );
        });
      },
    },
    {
      provide: DocumentTools,
      inject: [
        DB_CLIENT,
        KEY_PROVIDER,
        OBJECT_STORE,
        DOCUMENT_GIT,
        API_CONFIG,
        CLOCK,
        TopicHub,
        AppLogger,
      ],
      useFactory: (
        db: DbClient,
        keys: KeyProvider,
        objects: ObjectStore,
        git: GitService,
        config: ApiConfig,
        clock: Clock,
        hub: TopicHub,
        logger: AppLogger,
      ) =>
        new DocumentTools(
          new DocumentRepository({
            db,
            keys,
            objects,
            git,
            accessPolicy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
            now: () => clock.now(),
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
              onError: () => logger.warn("documents.announce_failed"),
            },
          }),
        ),
    },
    {
      provide: SimonRepository,
      inject: [DB_CLIENT, KEY_PROVIDER, CLOCK, API_CONFIG],
      useFactory: (db: DbClient, keys: KeyProvider, clock: Clock, config: ApiConfig) =>
        new SimonRepository({
          db,
          keys,
          now: () => clock.now(),
          policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
          quickChatTtlHours: config.QUICK_CHAT_TTL_HOURS,
        }),
    },
    SimonLifecycle,
    SimonTopics,
  ],
  exports: [SimonRepository],
})
export class SimonModule {}
