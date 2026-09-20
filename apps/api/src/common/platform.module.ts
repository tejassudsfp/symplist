import { type DynamicModule, Module, type Provider } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type { EmailTransport } from "@symplist/email";
import { analyticsProviders, SERVER_ANALYTICS } from "../infra/analytics/analytics.providers.ts";
import { API_CONFIG, type ApiConfig } from "../infra/config/api-config.ts";
import { cryptoProviders, KEY_PROVIDER } from "../infra/crypto/crypto.providers.ts";
import { D1_COUNTERS, DB_CLIENT, dbProviders, LOCAL_DATA_DIR } from "../infra/db/db.providers.ts";
import {
  EMAIL_TRANSPORT,
  EMAIL_TRANSPORT_OVERRIDE,
  emailProviders,
} from "../infra/email/email.providers.ts";
import { OTP_SERVICE, OTP_TEST_OUTBOX, otpProviders } from "../infra/email/otp.ts";
import { DurableCounterService } from "../infra/limits/durable-counter.ts";
import { IpFailureLimiter } from "../infra/limits/ip-failures.ts";
import { IpThrottlerGuard, ipThrottlerProviders } from "../infra/limits/ip-throttler.ts";
import {
  isRuntimeTimers,
  RUNTIME_TIMERS,
  type RuntimeTimers,
  systemTimers,
} from "../infra/scheduler/runtime.ts";
import { OBJECT_STORE, storageProviders } from "../infra/storage/storage.providers.ts";
import {
  ACCESS_SERVICE,
  ACCOUNT_DELETION,
  ACCOUNT_KEYS,
  accessProviders,
  RestrictionEffectRegistry,
} from "./access/access.providers.ts";
import { SessionService } from "./auth/session.service.ts";
import { CLOCK, type Clock, systemClock } from "./clock.ts";
import { AccessGuard } from "./guards/access.guard.ts";
import { RouteClassGuard } from "./guards/route-class.guard.ts";
import {
  IDEMPOTENCY_STORE,
  IdempotencyInterceptor,
} from "./idempotency/idempotency.interceptor.ts";
import {
  AppLogger,
  LOG_LEVEL,
  LOG_SINK,
  type LogLevel,
  type LogSink,
  NestLoggerAdapter,
  stdoutLogSink,
} from "./logging/logger.ts";
import { RequestContextInterceptor } from "./request-context.ts";
import { RouteClassVerifier } from "./route-class.verifier.ts";
import { ShutdownCoordinator } from "./shutdown/shutdown.coordinator.ts";

export interface PlatformOptions {
  readonly config: ApiConfig;
  /** Defaults to the system clock; tests inject a fake clock. */
  readonly clock?: Clock;
  /**
   * Timers of the realtime gateway, internal endpoints, executors and scheduler. Defaults to `clock`
   * when it schedules timers itself (a `FakeClock`), otherwise to real timers.
   */
  readonly timers?: RuntimeTimers;
  /** Where `DATA_DRIVER=local` keeps its SQLite file and objects; defaults to `LOCAL_DATA_DIR`. */
  readonly localDataDir?: string;
  /** Defaults to standard output. */
  readonly logSink?: LogSink;
  readonly logLevel?: LogLevel;
  /** Replaces the configured email transport (tests use a capture transport). */
  readonly emailTransport?: EmailTransport;
  /** Extra global providers, such as realtime seam implementations or test fakes. */
  readonly providers?: readonly Provider[];
}

/** Tokens and services every feature module can inject. */
const exported = [
  API_CONFIG,
  CLOCK,
  RUNTIME_TIMERS,
  LOG_SINK,
  DB_CLIENT,
  OBJECT_STORE,
  KEY_PROVIDER,
  EMAIL_TRANSPORT,
  SERVER_ANALYTICS,
  D1_COUNTERS,
  ACCESS_SERVICE,
  ACCOUNT_KEYS,
  ACCOUNT_DELETION,
  RestrictionEffectRegistry,
  IDEMPOTENCY_STORE,
  AppLogger,
  NestLoggerAdapter,
  SessionService,
  DurableCounterService,
  IpFailureLimiter,
];

/**
 * The api platform (§5, §6): configuration, drivers, logging, sessions and access, idempotency,
 * abuse limits and shutdown ordering. Global, so feature modules inject its tokens directly.
 *
 * Global guards run in declaration order: per-IP buckets first (no D1), then the route class
 * (Origin, cookies, credentials; no D1), then access (session lookup). The request-context
 * interceptor runs before the idempotency interceptor.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes configured through a static forRoot.
export class PlatformModule {
  static forRoot(options: PlatformOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: API_CONFIG, useValue: options.config },
      { provide: CLOCK, useValue: options.clock ?? systemClock },
      {
        provide: RUNTIME_TIMERS,
        useValue: options.timers ?? (isRuntimeTimers(options.clock) ? options.clock : systemTimers),
      },
      { provide: LOG_SINK, useValue: options.logSink ?? stdoutLogSink },
      { provide: LOG_LEVEL, useValue: options.logLevel ?? "info" },
      {
        provide: LOCAL_DATA_DIR,
        useValue: options.localDataDir ?? options.config.LOCAL_DATA_DIR,
      },
      ...(options.emailTransport
        ? [{ provide: EMAIL_TRANSPORT_OVERRIDE, useValue: options.emailTransport }]
        : []),
      AppLogger,
      NestLoggerAdapter,
      ...dbProviders,
      ...storageProviders,
      ...cryptoProviders,
      ...emailProviders,
      ...otpProviders,
      ...analyticsProviders,
      SessionService,
      ...accessProviders,
      DurableCounterService,
      IpFailureLimiter,
      ...ipThrottlerProviders,
      { provide: APP_GUARD, useClass: IpThrottlerGuard },
      { provide: APP_GUARD, useClass: RouteClassGuard },
      { provide: APP_GUARD, useClass: AccessGuard },
      { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
      { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      RouteClassVerifier,
      ShutdownCoordinator,
      ...(options.providers ?? []),
    ];
    const extraTokens = (options.providers ?? []).map((provider) =>
      typeof provider === "function" ? provider : provider.provide,
    );
    return {
      module: PlatformModule,
      global: true,
      providers,
      exports: [...exported, OTP_SERVICE, OTP_TEST_OUTBOX, ...extraTokens],
    };
  }
}
