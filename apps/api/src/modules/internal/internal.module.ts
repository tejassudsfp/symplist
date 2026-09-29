import { type DynamicModule, Module } from "@nestjs/common";
import type { ModuleDependenciesOptions } from "../../infra/scheduler/module-options.ts";
import { nestOperationalLog, systemTimers } from "../../infra/scheduler/runtime.ts";
import { INTERNAL_DEPENDENCIES, type InternalDependencies } from "./internal.tokens.ts";
import { InternalEventHandlerRegistry } from "./internal-event-handlers.ts";
import { InternalEventsController } from "./internal-events.controller.ts";
import { INTERNAL_LOG } from "./internal-log.ts";
import { InternalRequestVerifier } from "./internal-request.verifier.ts";
import { EventIdMemory } from "./replay-memory.ts";

/**
 * Internal worker endpoints (§6.2), outside `/v1`, in the `signed` route class: no cookies, no
 * CORS, the platform's error envelope and request context. Global: features inject
 * `InternalEventHandlerRegistry` to handle their worker announcements.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with a static forRoot.
export class InternalModule {
  static forRoot(options: ModuleDependenciesOptions<InternalDependencies>): DynamicModule {
    return {
      module: InternalModule,
      global: true,
      imports: [...(options.imports ?? [])],
      controllers: [InternalEventsController],
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
      ],
      exports: [InternalEventHandlerRegistry],
    };
  }
}
