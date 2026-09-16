import { sql } from "@symplist/db";
import { archiveGuard } from "../archive-runner.ts";
import type { ArchiveContributor } from "./types.ts";

/** Scheduling task-archive statements (§2.1). Cancel the tasks' pending occurrences and outbox rows and increment reminder generations (§12.4). */
export const schedulingArchiveContributor: ArchiveContributor = {
  domain: "scheduling",
  statements: (input) => {
    const guard = archiveGuard(input);
    const params = {
      scheduling_owner: input.ownerId,
      scheduling_w: input.writeId,
      ...guard.params,
      ...input.archivedTaskIds.params,
    };
    const where = `owner_id=:scheduling_owner AND task_id IN (${input.archivedTaskIds.sql}) AND ${guard.exists}`;
    return [
      sql(
        `UPDATE reminders SET generation=generation+1,status='cancelled',write_id=:scheduling_w WHERE status='active' AND ${where}`,
        params,
      ),
      sql(
        `UPDATE reminder_occurrences SET status='cancelled',write_id=:scheduling_w WHERE status IN ('pending','claimed') AND ${where}`,
        params,
      ),
      sql(
        `UPDATE notification_outbox SET status='cancelled',write_id=:scheduling_w WHERE status IN ('pending','claimed','uncertain') AND ${where}`,
        params,
      ),
    ];
  },
};
