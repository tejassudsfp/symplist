import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { ExecutorStateService } from "../executors/executor-state.ts";
import { LocalScheduler } from "./local-scheduler.ts";
import type { ModuleDependenciesOptions } from "./module-options.ts";
import {
  nestOperationalLog,
  type OperationalLog,
  type RuntimeTimers,
  systemTimers,
} from "./runtime.ts";

export interface SchedulerDependencies {
  /** `DURABLE`: the local scheduler runs only when false. */
  readonly durable: boolean;
  readonly timers?: RuntimeTimers;
  readonly log?: OperationalLog;
}

export const SCHEDULER_DEPENDENCIES = "symplist:scheduler-dependencies";

@Injectable()
export class LocalSchedulerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(LocalScheduler) private readonly scheduler: LocalScheduler) {}

  onApplicationBootstrap(): void {
    this.scheduler.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.scheduler.stop();
  }
}

/**
 * The local scheduler (§8.8, §12.2). Global: features inject `LocalScheduler` and register their
 * scanners and hourly jobs in `onModuleInit`. Requires `ExecutorsModule` for the generation guard.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with a static forRoot.
export class SchedulerModule {
  static forRoot(options: ModuleDependenciesOptions<SchedulerDependencies>): DynamicModule {
    return {
      module: SchedulerModule,
      global: true,
      imports: [...(options.imports ?? [])],
      providers: [
        {
          provide: SCHEDULER_DEPENDENCIES,
          useFactory: options.useFactory,
          inject: [...(options.inject ?? [])],
        },
        {
          provide: LocalScheduler,
          inject: [SCHEDULER_DEPENDENCIES, ExecutorStateService],
          useFactory: (dependencies: SchedulerDependencies, state: ExecutorStateService) =>
            new LocalScheduler({
              durable: dependencies.durable,
              state,
              timers: dependencies.timers ?? systemTimers,
              log: dependencies.log ?? nestOperationalLog("LocalScheduler"),
            }),
        },
        LocalSchedulerLifecycle,
      ],
      exports: [LocalScheduler],
    };
  }
}
