import { type DynamicModule, Module } from "@nestjs/common";
import type { ModuleDependenciesOptions } from "../../infra/scheduler/module-options.ts";
import { nestOperationalLog, systemTimers } from "../../infra/scheduler/runtime.ts";
import { AccessSweep } from "./access-sweep.ts";
import { RealtimeGateway } from "./realtime.gateway.ts";
import {
  REALTIME_DEPENDENCIES,
  REALTIME_POST_COMMIT_HOOK,
  REALTIME_PUBLISHER,
  type RealtimeDependencies,
} from "./realtime.tokens.ts";
import { RealtimeSessionControl } from "./session-control.ts";
import { TopicHub } from "./topic-hub.ts";
import { TopicRegistry } from "./topic-registry.ts";
import { RealtimeUpgradeGate } from "./upgrade-gate.ts";

/**
 * The WebSocket gateway and realtime publication (§7). Global: features inject `TopicRegistry` to
 * register topic authorizers and snapshot providers, and `REALTIME_PUBLISHER` (or `TopicHub`) to
 * publish. The bootstrap installs `AuthWsAdapter` and hands `REALTIME_POST_COMMIT_HOOK` to the
 * restriction routine.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with a static forRoot.
export class RealtimeModule {
  static forRoot(options: ModuleDependenciesOptions<RealtimeDependencies>): DynamicModule {
    return {
      module: RealtimeModule,
      global: true,
      imports: [...(options.imports ?? [])],
      providers: [
        {
          provide: REALTIME_DEPENDENCIES,
          useFactory: options.useFactory,
          inject: [...(options.inject ?? [])],
        },
        { provide: TopicRegistry, useFactory: () => new TopicRegistry() },
        {
          provide: TopicHub,
          inject: [REALTIME_DEPENDENCIES, TopicRegistry],
          useFactory: (dependencies: RealtimeDependencies, registry: TopicRegistry) =>
            new TopicHub({
              registry,
              access: dependencies.access,
              timers: dependencies.timers ?? systemTimers,
              log: dependencies.log ?? nestOperationalLog("TopicHub"),
              ...(dependencies.events === undefined ? {} : { events: dependencies.events }),
              ...(dependencies.tuning?.bufferCapacity === undefined
                ? {}
                : { bufferCapacity: dependencies.tuning.bufferCapacity }),
              ...(dependencies.tuning?.idleTopicMs === undefined
                ? {}
                : { idleTopicMs: dependencies.tuning.idleTopicMs }),
            }),
        },
        { provide: REALTIME_PUBLISHER, useExisting: TopicHub },
        {
          provide: RealtimeUpgradeGate,
          inject: [REALTIME_DEPENDENCIES],
          useFactory: (dependencies: RealtimeDependencies) =>
            new RealtimeUpgradeGate({
              allowedOrigins: dependencies.allowedOrigins,
              resolver: dependencies.sessions,
              access: dependencies.access,
              log: dependencies.log ?? nestOperationalLog("RealtimeUpgradeGate"),
              now: () => (dependencies.timers ?? systemTimers).now(),
              ...(dependencies.tuning?.sessionCacheTtlMs === undefined
                ? {}
                : { sessionCacheTtlMs: dependencies.tuning.sessionCacheTtlMs }),
            }),
        },
        {
          provide: AccessSweep,
          inject: [REALTIME_DEPENDENCIES, TopicHub],
          useFactory: (dependencies: RealtimeDependencies, hub: TopicHub) =>
            new AccessSweep({
              db: dependencies.db,
              hub,
              timers: dependencies.timers ?? systemTimers,
              log: dependencies.log ?? nestOperationalLog("AccessSweep"),
              ...(dependencies.tuning?.sweepIntervalMs === undefined
                ? {}
                : { intervalMs: dependencies.tuning.sweepIntervalMs }),
            }),
        },
        {
          provide: REALTIME_POST_COMMIT_HOOK,
          inject: [REALTIME_DEPENDENCIES, TopicHub, AccessSweep],
          useFactory: (dependencies: RealtimeDependencies, hub: TopicHub, sweep: AccessSweep) =>
            new RealtimeSessionControl({
              hub,
              sweep,
              log: dependencies.log ?? nestOperationalLog("RealtimeSessionControl"),
            }),
        },
        RealtimeGateway,
      ],
      exports: [TopicRegistry, TopicHub, REALTIME_PUBLISHER, REALTIME_POST_COMMIT_HOOK],
    };
  }
}
