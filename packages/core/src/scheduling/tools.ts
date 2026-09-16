import {
  type SchedulingReminderInput,
  type TaskScheduleToolInput,
  taskScheduleToolInputSchema,
} from "@symplist/contracts";
import { sql } from "@symplist/db";
import type { SchedulingGuard, SchedulingService } from "./service.ts";
import { SchedulingError } from "./time.ts";

/** Built only from authenticated run/grant identity. Guards fence the actual deciding SQL, not just a pre-read. */
export interface SchedulingToolActor {
  readonly kind: "simon" | "mcp";
  readonly ownerId: string;
  readonly requestId: string;
  readonly taskIds: readonly string[] | null;
  readonly scopes: readonly string[];
  readonly guards: readonly SchedulingGuard[];
}
export async function taskScheduleTool(
  service: SchedulingService,
  actor: SchedulingToolActor,
  raw: TaskScheduleToolInput,
) {
  const input = taskScheduleToolInputSchema.parse(raw);
  const write = input.operation !== "read";
  if (
    !actor.guards.length ||
    (actor.taskIds !== null && !actor.taskIds.includes(input.taskId)) ||
    (actor.kind === "mcp" &&
      !actor.scopes.some((scope) => scope === "tasks:write" || (!write && scope === "tasks:read")))
  )
    throw new SchedulingError("not_found");
  if (write) {
    const replay = await service.replay({
      ownerId: actor.ownerId,
      requestId: actor.requestId,
      actor: actor.kind,
      guards: actor.guards,
      fingerprint: input,
    });
    if (replay) return replay;
  }
  const current = await service.get(actor.ownerId, input.taskId, actor.guards);
  if (input.operation === "read") return current;
  let deadline = current.deadline;
  let reminders: SchedulingReminderInput[] = current.reminders.map(
    ({ id, rule, channels, overrideQuiet }) => ({ id, rule, channels, overrideQuiet }),
  );
  switch (input.operation) {
    case "set_deadline":
      deadline = input.deadline;
      break;
    case "clear_deadline":
      if (
        !input.removeRelativeReminders &&
        reminders.some((reminder) => reminder.rule.kind !== "absolute")
      )
        throw new SchedulingError("schedule.deadline_required");
      deadline = null;
      reminders = reminders.filter((reminder) => reminder.rule.kind === "absolute");
      break;
    case "add_reminder":
      reminders.push(input.reminder);
      break;
    case "update_reminder":
      if (!reminders.some((reminder) => reminder.id === input.reminderId))
        throw new SchedulingError("not_found");
      reminders = reminders.map((reminder) =>
        reminder.id === input.reminderId ? { ...input.reminder, id: reminder.id } : reminder,
      );
      break;
    case "cancel_reminder":
      if (!reminders.some((reminder) => reminder.id === input.reminderId))
        throw new SchedulingError("not_found");
      reminders = reminders.filter((reminder) => reminder.id !== input.reminderId);
      break;
    case "snooze": {
      const row = await service.options.db.first(
        sql(
          "SELECT channels_json,override_quiet FROM reminders WHERE id=:id AND owner_id=:owner AND task_id=:task",
          { id: input.reminderId, owner: actor.ownerId, task: input.taskId },
        ),
      );
      if (!row) throw new SchedulingError("not_found");
      reminders.push({
        rule: { kind: "absolute", ...input.when },
        channels: JSON.parse(String(row.channels_json)),
        overrideQuiet: row.override_quiet === 1,
      });
      break;
    }
  }
  return service.save({
    ownerId: actor.ownerId,
    taskId: input.taskId,
    actor: actor.kind,
    requestId: actor.requestId,
    guards: actor.guards,
    fingerprintInput: input,
    data: { baseVersion: input.expectedVersion, deadline, reminders },
  });
}
