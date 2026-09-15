import type {
  AccessPostCommitHook,
  AccessRestrictedEvent,
  SessionsEndedEvent,
} from "@symplist/core/events";
import { errorCode, type OperationalLog } from "../scheduler/runtime.ts";
import type { DispatchIntentRepository } from "./dispatch-intents.ts";
import type { LocalExecutor } from "./local-executor.ts";
import type { TriggerExecutor } from "./trigger-executor.ts";

/**
 * After a restriction commits (§5.5), stops the runs its batch cancelled: Trigger `runs.cancel` for
 * durable runs with a stored Trigger run id, or the local controllers in local mode. The batch already
 * wrote `cancel_requested_at` or `stopped`, so a failed cancel only delays the worker's own check.
 */
export class ExecutionPostCommitHook implements AccessPostCommitHook {
  constructor(
    private readonly options: {
      readonly repository: DispatchIntentRepository;
      readonly local: LocalExecutor | null;
      readonly trigger: TriggerExecutor | null;
      readonly log: OperationalLog;
    },
  ) {}

  async onSessionsEnded(_event: SessionsEndedEvent): Promise<void> {}

  async onAccessRestricted(event: AccessRestrictedEvent): Promise<void> {
    if (event.cancelledRunIds.length === 0) return;
    const { local, trigger, repository, log } = this.options;
    if (local) {
      local.abortSubjects(null, event.cancelledRunIds, "stopped");
      return;
    }
    if (!trigger) return;
    let intents: Awaited<ReturnType<DispatchIntentRepository["triggerRunsForSubjects"]>>;
    try {
      intents = await repository.triggerRunsForSubjects(event.cancelledRunIds);
    } catch (error) {
      log.error("executor.restriction_cancel_lookup_failed", {
        userId: event.userId,
        code: errorCode(error),
      });
      return;
    }
    for (const intent of intents) {
      if (intent.ownerId !== event.userId) continue;
      try {
        await trigger.cancel({
          kind: intent.kind,
          subjectId: intent.subjectId,
          triggerRunId: intent.triggerRunId,
        });
      } catch (error) {
        log.warn("executor.restriction_cancel_failed", {
          userId: event.userId,
          subjectId: intent.subjectId,
          triggerRunId: intent.triggerRunId,
          code: errorCode(error),
        });
      }
    }
  }
}
