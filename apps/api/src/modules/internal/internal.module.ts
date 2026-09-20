import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ExecutorStateService } from "../../infra/executors/executor-state.ts";
import type { ModuleDependenciesOptions } from "../../infra/scheduler/module-options.ts";
import { nestOperationalLog, systemTimers } from "../../infra/scheduler/runtime.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { INTERNAL_DEPENDENCIES, type InternalDependencies } from "./internal.tokens.ts";
import { InternalEventHandlerRegistry } from "./internal-event-handlers.ts";
import { InternalEventsController } from "./internal-events.controller.ts";
import { INTERNAL_LOG } from "./internal-log.ts";
import { InternalRequestVerifier } from "./internal-request.verifier.ts";
import { EventIdMemory } from "./replay-memory.ts";
import { RunOutputController } from "./run-output.controller.ts";
import { RunOutputRelay } from "./run-output.relay.ts";

/** Zeroises the relay's cached account keys once the application shut down (§4.1). */
@Injectable()
export class RunOutputRelayLifecycle implements OnApplicationShutdown {
  constructor(@Inject(RunOutputRelay) private readonly relay: RunOutputRelay) {}

  onApplicationShutdown(): void {
    this.relay.clear();
  }
}

/**
 * Internal worker endpoints (§6.2, §8.2), outside `/v1`, in the `signed` route class: no cookies, no
 * CORS, the platform's error envelope and request context. Global: features inject
 * `InternalEventHandlerRegistry` to handle their worker announcements. Requires `RealtimeModule` (the
 * topic hub) and `ExecutorsModule` (the executor generation).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with a static forRoot.
export class InternalModule {
  static forRoot(options: ModuleDependenciesOptions<InternalDependencies>): DynamicModule {
    return {
      module: InternalModule,
      global: true,
      imports: [...(options.imports ?? [])],
      controllers: [InternalEventsController, RunOutputController],
      providers: [
        {
          provide: INTERNAL_DEPENDENCIES,
          useFactory: options.useFactory,
          inject: [...(options.inject ?? [])],
        },
        {
          provide: INTERNAL_LOG,
          inject: [INTERNAL_DEPENDENCIES],
          useFactory: (dependencies: InternalDependencies) =>
            dependencies.log ?? nestOperationalLog("InternalEndpoints"),
        },
        {
          provide: InternalEventHandlerRegistry,
          useFactory: () => new InternalEventHandlerRegistry(),
        },
        {
          provide: InternalRequestVerifier,
          inject: [INTERNAL_DEPENDENCIES, INTERNAL_LOG],
          useFactory: (dependencies: InternalDependencies, log: InternalDependencies["log"]) => {
            const timers = dependencies.timers ?? systemTimers;
            return new InternalRequestVerifier({
              keys: dependencies.keys,
              memory: new EventIdMemory(timers, {
                ...(dependencies.tuning?.replayMemoryCapacity === undefined
                  ? {}
                  : { capacity: dependencies.tuning.replayMemoryCapacity }),
              }),
              timers,
              log: log ?? nestOperationalLog("InternalEndpoints"),
            });
          },
        },
        {
          provide: RunOutputRelay,
          inject: [INTERNAL_DEPENDENCIES, INTERNAL_LOG, ExecutorStateService, TopicHub],
          useFactory: (
            dependencies: InternalDependencies,
            log: NonNullable<InternalDependencies["log"]>,
            executorState: ExecutorStateService,
            hub: TopicHub,
          ) =>
            new RunOutputRelay({
              source: dependencies.runRelaySource,
              accountKeys: dependencies.accountKeys,
              executorState,
              hub,
              timers: dependencies.timers ?? systemTimers,
              log,
              ...(dependencies.tuning?.runStateTtlMs === undefined
                ? {}
                : { stateTtlMs: dependencies.tuning.runStateTtlMs }),
            }),
        },
        RunOutputRelayLifecycle,
      ],
      exports: [InternalEventHandlerRegistry, RunOutputRelay],
    };
  }
}
