import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from "@nestjs/common";
import type { AdminBootstrapService, RedemptionService } from "@symplist/core/access";
import { AppLogger } from "../../common/logging/logger.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { LocalScheduler } from "../../infra/scheduler/local-scheduler.ts";
import { RUNTIME_TIMERS, type RuntimeTimers } from "../../infra/scheduler/runtime.ts";
import { ADMIN_BOOTSTRAP_SERVICE, REDEMPTION_SERVICE } from "./access.tokens.ts";
import { AccessRealtime } from "./access-realtime.ts";

/** The local reconciler job, at a minute no other hourly job uses by default. */
export const REDEMPTION_RECONCILE_JOB = Object.freeze({
  name: "access-redemption-reconcile",
  minute: 20,
});

/** With `DURABLE=true` the local scheduler never runs, so the api drives the reconciler itself. */
export const DURABLE_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The access feature's background work:
 *
 * - the redemption reconciler (§5.4), which finalizes claimed seats whose follow-up batch never
 *   committed: an hourly local-scheduler job when `DURABLE=false` (it runs only while the recorded
 *   executor mode is local and background loops are on), and a 15-minute api timer when
 *   `DURABLE=true`, where the local scheduler never starts;
 * - admin bootstrap at startup (§5.7): once, when `ADMIN_BOOTSTRAP_EMAIL` is set and bootstrap was
 *   not consumed; a warning when bootstrap was consumed and the variable is still set.
 */
@Injectable()
export class AccessBackgroundJobs
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private timer: unknown;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(REDEMPTION_SERVICE) private readonly redemptions: RedemptionService,
    @Inject(ADMIN_BOOTSTRAP_SERVICE) private readonly bootstrap: AdminBootstrapService,
    @Inject(LocalScheduler) private readonly scheduler: LocalScheduler,
    @Inject(RUNTIME_TIMERS) private readonly timers: RuntimeTimers,
    private readonly realtime: AccessRealtime,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    if (this.config.DURABLE) return;
    this.scheduler.registerHourlyJob({
      ...REDEMPTION_RECONCILE_JOB,
      run: () => this.reconcile(),
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.bootstrapAdmin();
    if (this.config.DURABLE) {
      this.timer = this.timers.setInterval(() => {
        void this.reconcile();
      }, DURABLE_RECONCILE_INTERVAL_MS);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One reconciler pass; concurrent calls share it. Notifies every account it admitted. */
  reconcile(): Promise<void> {
    this.running ??= (async () => {
      try {
        const finalized = await this.redemptions.reconcile();
        let admitted = 0;
        for (const redemption of finalized) {
          if (!redemption.granted || !redemption.access) continue;
          admitted += 1;
          await this.realtime.accessChanged(redemption.userId, redemption.access, {
            generationMoved: true,
          });
        }
        if (finalized.length > 0) {
          this.logger.info("access.redemptions_reconciled", {
            count: finalized.length,
            admittedCount: admitted,
          });
        }
      } catch (error) {
        this.logger.warn("access.redemption_reconcile_failed", { error });
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async bootstrapAdmin(): Promise<void> {
    const email = this.config.ADMIN_BOOTSTRAP_EMAIL;
    if (email === undefined) return;
    try {
      if (await this.bootstrap.isConsumed()) {
        this.logger.warn("access.admin_bootstrap_variable_still_set");
        return;
      }
      const outcome = await this.bootstrap.bootstrap(email);
      if (outcome.status === "promoted") {
        this.logger.info("access.admin_bootstrapped", { userId: outcome.userId });
      } else {
        this.logger.info("access.admin_bootstrap_pending", { status: outcome.status });
      }
    } catch (error) {
      this.logger.error("access.admin_bootstrap_failed", { error });
    }
  }
}
