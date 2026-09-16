import { quiesceSimon } from "../../simon/quiesce.ts";
import { archiveGuard } from "../archive-runner.ts";
import type { ArchiveContributor } from "./types.ts";

/** Simon task-archive statements (§2.1). Stop or cancel the tasks' runs, expire pending approvals and user asks without continuation intents, and cancel queued messages and dispatch intents (§8.1). */
export const simonArchiveContributor: ArchiveContributor = {
  domain: "simon",
  blockingCondition: (input) => ({
    sql: `EXISTS (SELECT 1 FROM runs WHERE owner_id = :simon_owner AND task_id IN (${input.taskIdsQuery.sql})
      AND status IN ('queued', 'running', 'awaiting_approval', 'awaiting_user'))`,
    params: { simon_owner: input.ownerId, ...input.taskIdsQuery.params },
  }),
  statements: (input) =>
    quiesceSimon({
      ownerId: input.ownerId,
      now: input.now,
      writeId: input.writeId,
      reason: "task_archived",
      guard: archiveGuard(input),
      tasks: input.archivedTaskIds,
    }),
};
