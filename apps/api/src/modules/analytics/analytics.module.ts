import { Module } from "@nestjs/common";
import type { ServerAnalyticsEmitter } from "@symplist/analytics/server";
import { AnalyticsService } from "@symplist/core/analytics";
import type { DbClient } from "@symplist/db";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { SERVER_ANALYTICS } from "../../infra/analytics/analytics.providers.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { AnalyticsController } from "./analytics.controller.ts";

/** The analytics feature: controllers, gateway handlers and providers live in this folder (§2.3). */
@Module({
  controllers: [AnalyticsController],
  providers: [
    {
      provide: AnalyticsService,
      inject: [DB_CLIENT, API_CONFIG, CLOCK, SERVER_ANALYTICS],
      useFactory: (
        db: DbClient,
        config: ApiConfig,
        clock: Clock,
        emitter: ServerAnalyticsEmitter,
      ) =>
        new AnalyticsService({
          db,
          emitter,
          enabled: config.ANALYTICS_ENABLED && Boolean(config.POSTHOG_PROJECT_KEY),
          policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
          now: () => clock.now(),
        }),
    },
  ],
})
export class AnalyticsModule {}
