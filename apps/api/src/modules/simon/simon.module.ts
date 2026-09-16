import { Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { SimonRepository } from "@symplist/core/simon";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { ExecutionRegistry } from "../../infra/executors/execution-registry.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { createLocalSimonHandler } from "./simon.local.ts";

@Injectable()
export class SimonLifecycle implements OnModuleInit {
  constructor(
    @Inject(SimonRepository) private readonly repository: SimonRepository,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(ExecutionRegistry) private readonly registry: ExecutionRegistry,
    @Inject(TopicHub) private readonly hub: TopicHub,
    private readonly logger: AppLogger,
  ) {}
  onModuleInit(): void {
    if (!this.config.DURABLE)
      this.registry.registerLocalHandler(
        "simon_run",
        createLocalSimonHandler(this.repository, this.config, this.hub, this.logger),
      );
  }
}

/** The simon feature: controllers, gateway handlers and providers live in this folder (§2.3). */
@Module({
  providers: [
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
  ],
  exports: [SimonRepository],
})
export class SimonModule {}
