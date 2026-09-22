import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import {
  collectExecutionKinds,
  type EventsContributor,
  eventsContributors,
} from "@symplist/core/events";
import type { DbClient } from "@symplist/db";
import type { ModuleDependenciesOptions } from "../scheduler/module-options.ts";
import {
  errorCode,
  nestOperationalLog,
  type OperationalLog,
  type RuntimeTimers,
  systemTimers,
} from "../scheduler/runtime.ts";
import { DispatchIntentRepository } from "./dispatch-intents.ts";
import { ExecutionDispatcher } from "./dispatcher.ts";
import { ExecutionRegistry } from "./execution-registry.ts";
import type { TriggerRunsClient } from "./executor.ts";
import { ExecutorStateRepository, ExecutorStateService } from "./executor-state.ts";
import { LocalExecutor } from "./local-executor.ts";
import { ExecutionReconciler } from "./reconciler.ts";
import { RestrictedRunCanceller } from "./restricted-run-canceller.ts";
import { TriggerExecutor } from "./trigger-executor.ts";

export interface ExecutorsDependencies {
  readonly db: DbClient;
  readonly betaAccessRequired?: boolean;
  /** `DURABLE`. */
  readonly durable: boolean;
  /** The Trigger client; required when `durable` and never used otherwise. */
  readonly trigger?: TriggerRunsClient | null;
  /** `SIMON_CHAT_SESSIONS`: dispatch a kind that declares a session task through its session. */
  readonly chatSessions?: boolean;
  readonly timers?: RuntimeTimers;
  readonly log?: OperationalLog;
  /** Defaults to the core events contributors. */
  readonly contributors?: readonly EventsContributor[];
  /** Start the dispatcher kick and the reconciler at bootstrap; defaults to true. */
  readonly backgroundLoops?: boolean;
  readonly tuning?: {
    readonly reconcileIntervalMs?: number;
    readonly heartbeatIntervalMs?: number;
    readonly heartbeatTimeoutMs?: number;
    readonly claimLeaseMs?: number;
  };
}

export const EXECUTORS_DEPENDENCIES = "symplist:executors-dependencies";
/** The local executor in local mode, null in durable mode. */
export const LOCAL_EXECUTOR = "symplist:local-executor";
/** The Trigger executor in durable mode, null in local mode. */
export const TRIGGER_EXECUTOR = "symplist:trigger-executor";

const log = (dependencies: ExecutorsDependencies, context: string) =>
  dependencies.log ?? nestOperationalLog(context);
const timers = (dependencies: ExecutorsDependencies) => dependencies.timers ?? systemTimers;

@Injectable()
export class ExecutorsLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(EXECUTORS_DEPENDENCIES) private readonly dependencies: ExecutorsDependencies,
    @Inject(ExecutorStateService) private readonly state: ExecutorStateService,
    @Inject(ExecutionDispatcher) private readonly dispatcher: ExecutionDispatcher,
    @Inject(ExecutionReconciler) private readonly reconciler: ExecutionReconciler,
    @Inject(LOCAL_EXECUTOR) private readonly local: LocalExecutor | null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.state.initialize();
    } catch (error) {
      log(this.dependencies, "Executors").error("executor.state_initialize_failed", {
        code: errorCode(error),
      });
    }
    if (this.dependencies.backgroundLoops === false) return;
    this.reconciler.start();
    this.dispatcher.kick();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.reconciler.stop();
    await this.dispatcher.close();
    await this.local?.shutdown();
  }
}

/**
 * Dispatch, executors and reconciliation (§8.1). Global: features inject `ExecutionDispatcher` (kick
 * after committing an intent, Stop), `ExecutionRegistry` (local handlers) and `ExecutorStateService`.
 * Only the executor of the configured mode is constructed, so a local-mode api never uses a Trigger
 * client and a durable-mode api never runs handlers in process. `PlatformSeamsModule` binds
 * `RestrictedRunCanceller` to `RUN_CANCELLER`.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with a static forRoot.
export class ExecutorsModule {
  static forRoot(options: ModuleDependenciesOptions<ExecutorsDependencies>): DynamicModule {
    return {
      module: ExecutorsModule,
      global: true,
      imports: [...(options.imports ?? [])],
      providers: [
        {
          provide: EXECUTORS_DEPENDENCIES,
          useFactory: options.useFactory,
          inject: [...(options.inject ?? [])],
        },
        {
          provide: ExecutorStateService,
          inject: [EXECUTORS_DEPENDENCIES],
          useFactory: (dependencies: ExecutorsDependencies) =>
            new ExecutorStateService(
              new ExecutorStateRepository(dependencies.db),
              dependencies.durable ? "durable" : "local",
              timers(dependencies),
              log(dependencies, "ExecutorState"),
            ),
        },
        {
          provide: DispatchIntentRepository,
          inject: [EXECUTORS_DEPENDENCIES],
          useFactory: (dependencies: ExecutorsDependencies) =>
            new DispatchIntentRepository(dependencies.db),
        },
        {
          provide: ExecutionRegistry,
          inject: [EXECUTORS_DEPENDENCIES],
          useFactory: (dependencies: ExecutorsDependencies) =>
            new ExecutionRegistry(
              collectExecutionKinds(dependencies.contributors ?? eventsContributors),
              dependencies.db,
              dependencies.betaAccessRequired ?? true,
            ),
        },
        {
          provide: LOCAL_EXECUTOR,
          inject: [EXECUTORS_DEPENDENCIES, ExecutionRegistry],
          useFactory: (dependencies: ExecutorsDependencies, registry: ExecutionRegistry) =>
            dependencies.durable
              ? null
              : new LocalExecutor({
                  registry,
                  timers: timers(dependencies),
                  log: log(dependencies, "LocalExecutor"),
                  ...(dependencies.tuning?.heartbeatIntervalMs === undefined
                    ? {}
                    : { heartbeatIntervalMs: dependencies.tuning.heartbeatIntervalMs }),
                }),
        },
        {
          provide: TRIGGER_EXECUTOR,
          inject: [EXECUTORS_DEPENDENCIES],
          useFactory: (dependencies: ExecutorsDependencies) => {
            if (!dependencies.durable) return null;
            if (!dependencies.trigger) {
              throw new Error("DURABLE=true needs a Trigger client (TRIGGER_SECRET_KEY)");
            }
            return new TriggerExecutor(dependencies.trigger, {
              sessions: dependencies.chatSessions ?? false,
            });
          },
        },
        {
          provide: ExecutionDispatcher,
          inject: [
            EXECUTORS_DEPENDENCIES,
            DispatchIntentRepository,
            ExecutorStateService,
            ExecutionRegistry,
            LOCAL_EXECUTOR,
            TRIGGER_EXECUTOR,
          ],
          useFactory: (
            dependencies: ExecutorsDependencies,
            repository: DispatchIntentRepository,
            state: ExecutorStateService,
            registry: ExecutionRegistry,
            local: LocalExecutor | null,
            trigger: TriggerExecutor | null,
          ) => {
            const executor = local ?? trigger;
            if (!executor) throw new Error("No executor is configured");
            return new ExecutionDispatcher({
              repository,
              state,
              registry,
              executor,
              timers: timers(dependencies),
              log: log(dependencies, "ExecutionDispatcher"),
              ...(dependencies.tuning?.claimLeaseMs === undefined
                ? {}
                : { claimLeaseMs: dependencies.tuning.claimLeaseMs }),
            });
          },
        },
        {
          provide: ExecutionReconciler,
          inject: [
            EXECUTORS_DEPENDENCIES,
            DispatchIntentRepository,
            ExecutorStateService,
            ExecutionRegistry,
            ExecutionDispatcher,
            LOCAL_EXECUTOR,
            TRIGGER_EXECUTOR,
          ],
          useFactory: (
            dependencies: ExecutorsDependencies,
            repository: DispatchIntentRepository,
            state: ExecutorStateService,
            registry: ExecutionRegistry,
            dispatcher: ExecutionDispatcher,
            local: LocalExecutor | null,
            trigger: TriggerExecutor | null,
          ) =>
            new ExecutionReconciler({
              state,
              repository,
              registry,
              dispatcher,
              ...(local ? { local } : {}),
              ...(trigger ? { trigger } : {}),
              timers: timers(dependencies),
              log: log(dependencies, "ExecutionReconciler"),
              ...(dependencies.tuning?.reconcileIntervalMs === undefined
                ? {}
                : { intervalMs: dependencies.tuning.reconcileIntervalMs }),
              ...(dependencies.tuning?.heartbeatTimeoutMs === undefined
                ? {}
                : { heartbeatTimeoutMs: dependencies.tuning.heartbeatTimeoutMs }),
            }),
        },
        {
          provide: RestrictedRunCanceller,
          inject: [
            EXECUTORS_DEPENDENCIES,
            ExecutionRegistry,
            DispatchIntentRepository,
            LOCAL_EXECUTOR,
            TRIGGER_EXECUTOR,
          ],
          useFactory: (
            dependencies: ExecutorsDependencies,
            registry: ExecutionRegistry,
            repository: DispatchIntentRepository,
            local: LocalExecutor | null,
            trigger: TriggerExecutor | null,
          ) =>
            new RestrictedRunCanceller({
              registry,
              repository,
              local,
              trigger,
              log: log(dependencies, "RestrictedRunCanceller"),
            }),
        },
        ExecutorsLifecycle,
      ],
      exports: [
        ExecutorStateService,
        ExecutionRegistry,
        ExecutionDispatcher,
        ExecutionReconciler,
        DispatchIntentRepository,
        RestrictedRunCanceller,
        LOCAL_EXECUTOR,
        TRIGGER_EXECUTOR,
      ],
    };
  }
}
