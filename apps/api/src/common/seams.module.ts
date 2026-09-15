import { type DynamicModule, Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { ApiConfig } from "@symplist/config/api";
import type { AccountDeletionEffect } from "@symplist/core/account";
import type { DbClient } from "@symplist/db";
import {
  AnalyticsDeletionEffect,
  posthogDeletionClientFor,
} from "../infra/account/analytics-deletion.effect.ts";
import { PurgeDispatchEffect } from "../infra/account/purge-dispatch.effect.ts";
import { API_CONFIG } from "../infra/config/api-config.ts";
import { DB_CLIENT } from "../infra/db/db.providers.ts";
import { ExecutionDispatcher } from "../infra/executors/dispatcher.ts";
import { RestrictedRunCanceller } from "../infra/executors/restricted-run-canceller.ts";
import { createTriggerRunsClient } from "../infra/executors/trigger-sdk-client.ts";
import { RealtimeSessionControl } from "../modules/realtime/session-control.ts";
import { RealtimeShutdownControl } from "../modules/realtime/shutdown-control.ts";
import { ACCOUNT_DELETION_EFFECTS } from "./access/access.providers.ts";
import { CLOCK, type Clock } from "./clock.ts";
import { AppLogger } from "./logging/logger.ts";
import { appOperationalLog } from "./logging/operational-log.ts";
import {
  REALTIME_ACCESS_NOTIFIER,
  REALTIME_SHUTDOWN,
  type RealtimeAccessNotifier,
  RUN_CANCELLER,
  TRIGGER_CLIENT,
  type TriggerClientBinding,
} from "./seams.ts";

/** The Trigger client of a configuration: the SDK client in durable mode, none in local mode. */
export function triggerClientFor(
  config: Pick<ApiConfig, "DURABLE" | "TRIGGER_SECRET_KEY">,
): TriggerClientBinding {
  if (!config.DURABLE) return null;
  if (config.TRIGGER_SECRET_KEY === undefined) {
    throw new Error("DURABLE=true needs TRIGGER_SECRET_KEY");
  }
  return createTriggerRunsClient(config.TRIGGER_SECRET_KEY);
}

/**
 * `REALTIME_ACCESS_NOTIFIER`, resolved when a commit first notifies. The gateway's topic hub checks
 * access with the access service, whose restriction effects include this notifier, and the upgrade
 * resolver reads sessions from the session service, which notifies it on logout: binding the gateway
 * directly would make both constructions depend on themselves.
 */
export class RealtimeNotifierBinding implements RealtimeAccessNotifier {
  private target: RealtimeAccessNotifier | undefined;

  constructor(private readonly moduleRef: ModuleRef) {}

  accessRestricted(event: Parameters<RealtimeAccessNotifier["accessRestricted"]>[0]) {
    return this.notifier().accessRestricted(event);
  }

  sessionsEnded(event: Parameters<RealtimeAccessNotifier["sessionsEnded"]>[0]) {
    return this.notifier().sessionsEnded(event);
  }

  private notifier(): RealtimeAccessNotifier {
    if (!this.target) {
      const target = this.moduleRef.get(RealtimeSessionControl, { strict: false });
      if (!target) throw new Error("The realtime gateway is not part of this application");
      this.target = target;
    }
    return this.target;
  }
}

export interface PlatformSeamsOptions {
  /** Replaces the configured Trigger client; tests bind a `FakeTriggerClient`. */
  readonly triggerClient?: TriggerClientBinding;
}

/**
 * The one global module that binds the platform seams (§5.5, §7, §8.1, §5.6): `TRIGGER_CLIENT`,
 * `REALTIME_ACCESS_NOTIFIER` (the gateway's session control), `RUN_CANCELLER` (the executors'
 * restricted run canceller), `REALTIME_SHUTDOWN` (the gateway's shutdown control) and
 * `ACCOUNT_DELETION_EFFECTS` (the PostHog person deletion request and the purge dispatch). Restriction,
 * logout and session revocation therefore close the affected sockets and stop the user's runs, and
 * shutdown closes sockets with 1001 before HTTP drains.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with a static forRoot.
export class PlatformSeamsModule {
  static forRoot(options: PlatformSeamsOptions = {}): DynamicModule {
    return {
      module: PlatformSeamsModule,
      global: true,
      providers: [
        {
          provide: TRIGGER_CLIENT,
          inject: [API_CONFIG],
          useFactory: (config: ApiConfig): TriggerClientBinding =>
            options.triggerClient === undefined ? triggerClientFor(config) : options.triggerClient,
        },
        {
          provide: REALTIME_ACCESS_NOTIFIER,
          inject: [ModuleRef],
          useFactory: (moduleRef: ModuleRef) => new RealtimeNotifierBinding(moduleRef),
        },
        { provide: RUN_CANCELLER, useExisting: RestrictedRunCanceller },
        { provide: REALTIME_SHUTDOWN, useExisting: RealtimeShutdownControl },
        {
          provide: ACCOUNT_DELETION_EFFECTS,
          inject: [API_CONFIG, DB_CLIENT, CLOCK, AppLogger, ExecutionDispatcher],
          useFactory: (
            config: ApiConfig,
            db: DbClient,
            clock: Clock,
            logger: AppLogger,
            dispatcher: ExecutionDispatcher,
          ): readonly AccountDeletionEffect[] => [
            new AnalyticsDeletionEffect({
              client: posthogDeletionClientFor(config),
              db,
              now: () => clock.now(),
              log: appOperationalLog(logger),
            }),
            new PurgeDispatchEffect(dispatcher),
          ],
        },
      ],
      exports: [
        TRIGGER_CLIENT,
        REALTIME_ACCESS_NOTIFIER,
        RUN_CANCELLER,
        REALTIME_SHUTDOWN,
        ACCOUNT_DELETION_EFFECTS,
      ],
    };
  }
}
