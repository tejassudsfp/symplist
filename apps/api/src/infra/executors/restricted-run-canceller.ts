import type { RunCanceller } from "../../common/seams.ts";
import { errorCode, type OperationalLog } from "../scheduler/runtime.ts";
import type { DispatchIntentRepository } from "./dispatch-intents.ts";
import type { ExecutionRegistry } from "./execution-registry.ts";
import type { LocalExecutor } from "./local-executor.ts";
import type { TriggerExecutor } from "./trigger-executor.ts";

/** Active subjects listed per request, and pages per kind, when stopping a user's work. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * After a restriction commits (§5.5), stops the work its batch cancelled; bound to `RUN_CANCELLER`.
 * The batch already set `cancel_requested_at` on the user's queued and running subjects, so every
 * active subject of a tracked kind that belongs to the user and has its stop requested is stopped
 * here: its local controller is aborted in local mode, or Trigger `runs.cancel` is called for its
 * stored run in durable mode. Only this api's executor is ever called, and a failed cancel only
 * delays the worker's own check between steps, so failures are logged and never thrown.
 */
export class RestrictedRunCanceller implements RunCanceller {
  constructor(
    private readonly options: {
      readonly registry: ExecutionRegistry;
      readonly repository: DispatchIntentRepository;
      readonly local: LocalExecutor | null;
      readonly trigger: TriggerExecutor | null;
      readonly log: OperationalLog;
    },
  ) {}

  async cancelRestrictedRuns(
    event: Parameters<RunCanceller["cancelRestrictedRuns"]>[0],
  ): Promise<void> {
    const { registry, local, trigger, log } = this.options;
    const executor = local ? "local" : "trigger";
    let cancelled = 0;
    let failed = 0;
    for (const { kind, tracker } of registry.trackedKinds()) {
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        let active: Awaited<ReturnType<typeof tracker.listActive>>;
        try {
          active = await tracker.listActive({
            executor,
            limit: PAGE_SIZE,
            ownerId: event.userId,
            ...(after === undefined ? {} : { after }),
          });
        } catch (error) {
          failed += 1;
          log.error("executor.restriction_cancel_lookup_failed", {
            userId: event.userId,
            kind,
            code: errorCode(error),
          });
          break;
        }
        for (const execution of active) {
          if (execution.ownerId !== event.userId || execution.cancelRequestedAt === null) continue;
          if (local) {
            cancelled += local.abortSubjects(kind, [execution.subjectId], "stopped", event.userId);
            continue;
          }
          if (!trigger) continue;
          try {
            const triggerRunId =
              execution.triggerRunId ??
              (await this.options.repository.findBySubject(kind, execution.subjectId))
                ?.triggerRunId ??
              null;
            if (triggerRunId === null) continue;
            await trigger.cancel({ kind, subjectId: execution.subjectId, triggerRunId });
            cancelled += 1;
          } catch (error) {
            failed += 1;
            log.warn("executor.restriction_cancel_failed", {
              userId: event.userId,
              subjectId: execution.subjectId,
              code: errorCode(error),
            });
          }
        }
        const last = active.at(-1);
        if (active.length < PAGE_SIZE || last === undefined) break;
        after = last.subjectId;
      }
    }
    if (cancelled + failed > 0) {
      log.info("executor.restriction_cancelled", {
        userId: event.userId,
        accessGeneration: event.accessGeneration,
        executor,
        cancelled,
        failed,
      });
    }
  }
}
