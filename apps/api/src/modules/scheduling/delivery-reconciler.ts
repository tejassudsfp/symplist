import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { ResendDeliveryEvents } from "@symplist/core/scheduling";
import { AppLogger } from "../../common/logging/logger.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { RUNTIME_TIMERS, type RuntimeTimers } from "../../infra/scheduler/runtime.ts";

/** Only the API knows whether webhook tracking is enabled; the worker must never carry its secret. */
@Injectable()
export class DeliveryReconciler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: unknown;
  private running: Promise<void> | null = null;
  constructor(
    @Inject(API_CONFIG) readonly config: ApiConfig,
    @Inject(ResendDeliveryEvents) readonly events: ResendDeliveryEvents,
    @Inject(RUNTIME_TIMERS) readonly timers: RuntimeTimers,
    @Inject(AppLogger) readonly logger: AppLogger,
  ) {}
  onApplicationBootstrap() {
    if (this.config.RESEND_WEBHOOK_SECRET)
      this.timer = this.timers.setInterval(() => {
        void this.reconcile();
      }, 60000);
  }
  reconcile(): Promise<void> {
    if (!this.config.RESEND_WEBHOOK_SECRET) return Promise.resolve();
    this.running ??= this.events
      .reconcile()
      .catch(() => {
        this.logger.warn("email.delivery_reconcile_failed", {});
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  async beforeApplicationShutdown() {
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    await this.running;
  }
}
