import { Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import {
  cleanupHourly,
  cleanupSharedFeatures,
  NotificationsService,
  ReminderScanner,
  ResendDeliveryEvents,
  reminderPayloadFactory,
  SchedulingService,
} from "@symplist/core/scheduling";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { createEmailRenderer, type EmailTransport } from "@symplist/email";
import type { ObjectStore } from "@symplist/storage";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { EMAIL_TRANSPORT } from "../../infra/email/email.providers.ts";
import { LocalScheduler } from "../../infra/scheduler/local-scheduler.ts";
import { OBJECT_STORE } from "../../infra/storage/storage.providers.ts";
import { InternalEventHandlerRegistry } from "../internal/internal-event-handlers.ts";
import { TopicRegistry } from "../realtime/topic-registry.ts";
import { DeliveryReconciler } from "./delivery-reconciler.ts";
import { ResendWebhookController } from "./resend.controller.ts";
import { SchedulingController } from "./scheduling.controller.ts";
import { SchedulingRealtime } from "./scheduling.realtime.ts";
import { ReminderUnsubscribeController } from "./unsubscribe.controller.ts";

@Injectable()
export class SchedulingLifecycle implements OnModuleInit {
  constructor(
    @Inject(SchedulingService) private readonly service: SchedulingService,
    @Inject(SchedulingRealtime) private readonly realtime: SchedulingRealtime,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(EMAIL_TRANSPORT) private readonly email: EmailTransport,
    @Inject(LocalScheduler) private readonly scheduler: LocalScheduler,
    @Inject(InternalEventHandlerRegistry) private readonly internal: InternalEventHandlerRegistry,
    @Inject(TopicRegistry) private readonly topics: TopicRegistry,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
  ) {}
  onModuleInit() {
    this.topics.registerUserSnapshotContributor({
      name: "scheduling",
      contribute: async (session) => ({ unreadCount: await this.realtime.unread(session.userId) }),
    });
    this.internal.register({
      type: "schedule.changed",
      handle: async (event) => {
        if (typeof event.payload.taskId !== "string") return;
        // The signed event is still a hint: publish only the owner's persisted current version.
        const current = await this.service.get(event.ownerId, event.payload.taskId);
        await this.realtime.schedule(event.ownerId, event.payload.taskId, current.version);
      },
    });
    this.internal.register({
      type: "notifications.changed",
      handle: async (event) => {
        if (typeof event.payload.notificationId === "string")
          await this.realtime.changed(event.ownerId, event.payload.notificationId);
      },
    });
    this.internal.register({
      type: "notifications.summary",
      handle: async (event) => {
        await this.realtime.summary(event.ownerId, Number(event.payload.count));
      },
    });
    if (this.config.DURABLE) return;
    const renderer = createEmailRenderer({
      webOrigin: this.config.WEB_ORIGIN,
      apiOrigin: this.config.API_ORIGIN,
      accountHelpUrl: `${this.config.WEB_ORIGIN}/settings/account`,
    });
    const scanner = new ReminderScanner({
      ...this.service.options,
      email: this.email,
      maxLatenessHours: this.config.REMINDER_MAX_LATENESS_HOURS,
      renderEmail: reminderPayloadFactory(this.service, renderer, {
        webOrigin: this.config.WEB_ORIGIN,
        apiOrigin: this.config.API_ORIGIN,
      }),
      notify: (owner, id) => this.realtime.changed(owner, id),
      summary: (owner, count) => this.realtime.summary(owner, count),
    });
    this.scheduler.registerScanner({
      name: "reminder-scan",
      run: async (context) => {
        await scanner.run({
          executor: "local",
          generation: context.generation,
          signal: context.signal,
        });
      },
    });
    this.scheduler.registerHourlyJob({
      name: "cleanup-hourly",
      minute: 5,
      run: async (context) => {
        await cleanupHourly(
          {
            ...this.service.options,
            quickChatTtlHours: this.config.QUICK_CHAT_TTL_HOURS,
            cleanupFeatureExpiries: (_input, cleanup) =>
              cleanupSharedFeatures(cleanup, this.objects),
          },
          { executor: "local", generation: context.generation, signal: context.signal },
        );
      },
    });
  }
}

/** The scheduling feature: controllers, gateway handlers and providers live in this folder (§2.3). */
@Module({
  controllers: [SchedulingController, ResendWebhookController, ReminderUnsubscribeController],
  providers: [
    {
      provide: SchedulingService,
      inject: [DB_CLIENT, KEY_PROVIDER, API_CONFIG, CLOCK],
      useFactory: (db: DbClient, keys: KeyProvider, config: ApiConfig, clock: Clock) =>
        new SchedulingService({
          db,
          keys,
          now: () => clock.now(),
          policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
          remindersEnabled: config.REMINDERS_ENABLED,
          emailEnabled: config.REMINDER_EMAIL_ENABLED,
          defaultZone: config.DEFAULT_TIMEZONE,
          deliveryTracking: !!config.RESEND_WEBHOOK_SECRET,
        }),
    },
    {
      provide: NotificationsService,
      inject: [SchedulingService],
      useFactory: (service: SchedulingService) => new NotificationsService(service),
    },
    {
      provide: ResendDeliveryEvents,
      inject: [DB_CLIENT, KEY_PROVIDER, CLOCK],
      useFactory: (db: DbClient, keys: KeyProvider, clock: Clock) =>
        new ResendDeliveryEvents(db, keys, () => clock.now()),
    },
    DeliveryReconciler,
    SchedulingRealtime,
    SchedulingLifecycle,
  ],
  exports: [SchedulingService, NotificationsService],
})
export class SchedulingModule {}
