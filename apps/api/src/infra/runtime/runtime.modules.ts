import type { DynamicModule } from "@nestjs/common";
import type { AccessService } from "@symplist/core/access";
import type { AccountKeyStore } from "@symplist/core/account";
import {
  createRunRelaySource,
  type EventsContributor,
  eventsContributors,
} from "@symplist/core/events";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { ACCESS_SERVICE, ACCOUNT_KEYS } from "../../common/access/access.providers.ts";
import { SessionService } from "../../common/auth/session.service.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { appOperationalLog } from "../../common/logging/operational-log.ts";
import { TRIGGER_CLIENT, type TriggerClientBinding } from "../../common/seams.ts";
import { InternalModule } from "../../modules/internal/internal.module.ts";
import type { InternalDependencies } from "../../modules/internal/internal.tokens.ts";
import { RealtimeModule } from "../../modules/realtime/realtime.module.ts";
import type { RealtimeDependencies } from "../../modules/realtime/realtime.tokens.ts";
import { SessionUpgradeResolver } from "../../modules/realtime/session-resolver.ts";
import { AccountPurgeModule } from "../account/account-purge.module.ts";
import { API_CONFIG, type ApiConfig } from "../config/api-config.ts";
import { KEY_PROVIDER } from "../crypto/crypto.providers.ts";
import { DB_CLIENT } from "../db/db.providers.ts";
import { DocumentGitRuntimeModule } from "../documents/git.module.ts";
import { type ExecutorsDependencies, ExecutorsModule } from "../executors/executors.module.ts";
import { RUNTIME_TIMERS, type RuntimeTimers } from "../scheduler/runtime.ts";
import { type SchedulerDependencies, SchedulerModule } from "../scheduler/scheduler.module.ts";

/** Test and operations overrides of the runtime modules; production uses none of them. */
export interface RuntimeOptions {
  /**
   * Starts the background timers at bootstrap: the dispatcher kick and the reconciler, the gateway's
   * heartbeat and access sweep, and the local scheduler. Defaults to true; the test harness turns them
   * off, so a test that moves its fake clock by days does not run every firing on the way.
   */
  readonly backgroundLoops?: boolean;
  /**
   * Replaces the core events contributors of the same domains for the executors and the run output
   * relay (other domains keep theirs), so a test can register a probe execution kind with a tracker
   * and a run relay source.
   */
  readonly eventsContributors?: readonly EventsContributor[];
  readonly realtime?: {
    readonly tuning?: RealtimeDependencies["tuning"];
    /** Event data schemas by type; defaults to the composed contracts `wsEvents`. */
    readonly events?: RealtimeDependencies["events"];
  };
  readonly internal?: { readonly tuning?: InternalDependencies["tuning"] };
  readonly executors?: { readonly tuning?: ExecutorsDependencies["tuning"] };
}

/**
 * The executors, realtime gateway, internal endpoints, local scheduler and account purge, each built
 * from the platform's providers (config, D1, keys, sessions, access, timers, logger) so one process
 * shares one of each (§2, §7, §8.1). `PlatformSeamsModule` binds their post-commit and shutdown seams.
 */
export function runtimeModules(options: RuntimeOptions = {}): DynamicModule[] {
  const replaced = options.eventsContributors ?? [];
  const contributors: readonly EventsContributor[] = [
    ...eventsContributors.filter(
      (contributor) => !replaced.some((replacement) => replacement.domain === contributor.domain),
    ),
    ...replaced,
  ];
  return [
    { module: DocumentGitRuntimeModule },
    ExecutorsModule.forRoot({
      inject: [API_CONFIG, DB_CLIENT, TRIGGER_CLIENT, RUNTIME_TIMERS, AppLogger],
      useFactory: (
        config: ApiConfig,
        db: DbClient,
        trigger: TriggerClientBinding,
        timers: RuntimeTimers,
        logger: AppLogger,
      ): ExecutorsDependencies => ({
        db,
        betaAccessRequired: config.BETA_ACCESS_REQUIRED,
        durable: config.DURABLE,
        trigger,
        timers,
        log: appOperationalLog(logger),
        contributors,
        ...(options.backgroundLoops === undefined
          ? {}
          : { backgroundLoops: options.backgroundLoops }),
        ...(options.executors?.tuning === undefined ? {} : { tuning: options.executors.tuning }),
      }),
    }),
    RealtimeModule.forRoot({
      inject: [API_CONFIG, DB_CLIENT, SessionService, ACCESS_SERVICE, RUNTIME_TIMERS, AppLogger],
      useFactory: (
        config: ApiConfig,
        db: DbClient,
        sessions: SessionService,
        access: AccessService,
        timers: RuntimeTimers,
        logger: AppLogger,
      ): RealtimeDependencies => ({
        db,
        sessions: new SessionUpgradeResolver({ sessions, trustProxyHops: config.TRUST_PROXY_HOPS }),
        access,
        allowedOrigins: [config.WEB_ORIGIN],
        timers,
        log: appOperationalLog(logger),
        ...(options.backgroundLoops === undefined
          ? {}
          : { backgroundLoops: options.backgroundLoops }),
        ...(options.realtime?.events === undefined ? {} : { events: options.realtime.events }),
        ...(options.realtime?.tuning === undefined ? {} : { tuning: options.realtime.tuning }),
      }),
    }),
    InternalModule.forRoot({
      inject: [DB_CLIENT, KEY_PROVIDER, ACCOUNT_KEYS, RUNTIME_TIMERS, AppLogger],
      useFactory: (
        db: DbClient,
        keys: KeyProvider,
        accountKeys: AccountKeyStore,
        timers: RuntimeTimers,
        logger: AppLogger,
      ): InternalDependencies => ({
        keys,
        accountKeys,
        runRelaySource: createRunRelaySource({ db }, contributors),
        timers,
        log: appOperationalLog(logger),
        ...(options.internal?.tuning === undefined ? {} : { tuning: options.internal.tuning }),
      }),
    }),
    SchedulerModule.forRoot({
      inject: [API_CONFIG, RUNTIME_TIMERS, AppLogger],
      useFactory: (
        config: ApiConfig,
        timers: RuntimeTimers,
        logger: AppLogger,
      ): SchedulerDependencies => ({
        durable: config.DURABLE,
        timers,
        log: appOperationalLog(logger),
        ...(options.backgroundLoops === undefined
          ? {}
          : { backgroundLoops: options.backgroundLoops }),
      }),
    }),
    AccountPurgeModule.forRoot(),
  ];
}
