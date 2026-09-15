import { type DynamicModule, Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import {
  ACCOUNT_PURGE_INTENT_KIND,
  AccountPurgeRunner,
  providerPurgeStep,
  stragglerRunsPurgeStep,
} from "@symplist/core/account";
import type { DbClient } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { appOperationalLog } from "../../common/logging/operational-log.ts";
import { API_CONFIG, type ApiConfig } from "../config/api-config.ts";
import { DB_CLIENT } from "../db/db.providers.ts";
import { DispatchIntentRepository } from "../executors/dispatch-intents.ts";
import { ExecutionRegistry } from "../executors/execution-registry.ts";
import { ExecutorStateService } from "../executors/executor-state.ts";
import { LOCAL_EXECUTOR, TRIGGER_EXECUTOR } from "../executors/executors.module.ts";
import type { LocalExecutor } from "../executors/local-executor.ts";
import type { TriggerExecutor } from "../executors/trigger-executor.ts";
import { LocalScheduler } from "../scheduler/local-scheduler.ts";
import { OBJECT_STORE } from "../storage/storage.providers.ts";
import { AccountPurgeService } from "./account-purge.service.ts";

/** Injection token for the api's {@link AccountPurgeRunner} (§5.6). */
export const ACCOUNT_PURGE_RUNNER = "symplist:ACCOUNT_PURGE_RUNNER";

/** The local background purge job, at the minute the durable `cleanup-hourly` schedule uses (§8.8). */
export const ACCOUNT_PURGE_JOB = Object.freeze({ name: "account-purge", minute: 5 });

/**
 * The api's account purge runner (§5.6): owner rows through the purge contributors, R2 objects under
 * the account prefix, straggler runs through the trackers of the core events contributors on this
 * api's executor, and provider-side state through the purge contributors' provider purges.
 */
export function createApiAccountPurgeRunner(dependencies: {
  readonly config: Pick<ApiConfig, "DURABLE">;
  readonly db: DbClient;
  readonly store: ObjectStore;
  readonly clock: Clock;
  readonly registry: ExecutionRegistry;
  readonly repository: DispatchIntentRepository;
  readonly local: LocalExecutor | null;
  readonly trigger: TriggerExecutor | null;
}): AccountPurgeRunner {
  const { db, store, clock, registry, repository, local, trigger } = dependencies;
  const now = () => clock.now();
  return new AccountPurgeRunner({
    db,
    store,
    now,
    runs: stragglerRunsPurgeStep({
      trackedKinds: registry.trackedKinds(),
      executor: dependencies.config.DURABLE ? "trigger" : "local",
      now,
      cancel: async (execution) => {
        if (local) {
          local.abortSubjects(execution.kind, [execution.subjectId], "stopped", execution.ownerId);
          return;
        }
        if (!trigger) return;
        const triggerRunId =
          execution.triggerRunId ??
          (await repository.findBySubject(execution.kind, execution.subjectId))?.triggerRunId ??
          null;
        // A run that never reached Trigger has nothing to cancel there.
        if (triggerRunId === null) return;
        await trigger.cancel({
          kind: execution.kind,
          subjectId: execution.subjectId,
          triggerRunId,
        });
      },
    }),
    composio: providerPurgeStep({ dependencies: { db, now } }),
  });
}

/**
 * Registers the `DURABLE=false` purge: the in-process handler of the `account_purge` intent and the
 * hourly background job that resumes pending purges. In durable mode the `account-purge` Trigger task
 * owns the purge and nothing is registered here.
 */
@Injectable()
export class AccountPurgeRegistration implements OnModuleInit {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AccountPurgeService) private readonly purges: AccountPurgeService,
    @Inject(ExecutionRegistry) private readonly registry: ExecutionRegistry,
    @Inject(LocalScheduler) private readonly scheduler: LocalScheduler,
  ) {}

  onModuleInit(): void {
    if (this.config.DURABLE) return;
    this.registry.registerLocalHandler(ACCOUNT_PURGE_INTENT_KIND, async (job, context) => {
      await this.purges.purge(job.subjectId, context);
    });
    this.scheduler.registerHourlyJob({
      ...ACCOUNT_PURGE_JOB,
      run: async (context) => {
        await this.purges.resumePending(context);
      },
    });
  }
}

/**
 * The account purge runtime (§5.6, §8.8). Global: `ACCOUNT_PURGE_RUNNER` and `AccountPurgeService` are
 * injectable. Requires `ExecutorsModule` and `SchedulerModule`.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with a static forRoot.
export class AccountPurgeModule {
  static forRoot(): DynamicModule {
    return {
      module: AccountPurgeModule,
      global: true,
      providers: [
        {
          provide: ACCOUNT_PURGE_RUNNER,
          inject: [
            API_CONFIG,
            DB_CLIENT,
            OBJECT_STORE,
            CLOCK,
            ExecutionRegistry,
            DispatchIntentRepository,
            LOCAL_EXECUTOR,
            TRIGGER_EXECUTOR,
          ],
          useFactory: (
            config: ApiConfig,
            db: DbClient,
            store: ObjectStore,
            clock: Clock,
            registry: ExecutionRegistry,
            repository: DispatchIntentRepository,
            local: LocalExecutor | null,
            trigger: TriggerExecutor | null,
          ) =>
            createApiAccountPurgeRunner({
              config,
              db,
              store,
              clock,
              registry,
              repository,
              local,
              trigger,
            }),
        },
        {
          provide: AccountPurgeService,
          inject: [ACCOUNT_PURGE_RUNNER, ExecutorStateService, DB_CLIENT, AppLogger],
          useFactory: (
            runner: AccountPurgeRunner,
            state: ExecutorStateService,
            db: DbClient,
            logger: AppLogger,
          ) => new AccountPurgeService({ runner, state, db, log: appOperationalLog(logger) }),
        },
        AccountPurgeRegistration,
      ],
      exports: [ACCOUNT_PURGE_RUNNER, AccountPurgeService],
    };
  }
}
