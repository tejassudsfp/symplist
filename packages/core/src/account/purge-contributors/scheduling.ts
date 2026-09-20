import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

const tables = [
  "notifications",
  "notification_outbox",
  "reminder_occurrences",
  "reminders",
  "task_schedules",
  "notification_prefs",
  "schedule_audit",
] as const;
const children: Partial<Record<(typeof tables)[number], string>> = {
  reminder_occurrences:
    "AND NOT EXISTS(SELECT 1 FROM notification_outbox b WHERE b.occurrence_id=reminder_occurrences.id)",
  reminders:
    "AND NOT EXISTS(SELECT 1 FROM reminder_occurrences o WHERE o.reminder_id=reminders.id)",
  task_schedules:
    "AND NOT EXISTS(SELECT 1 FROM reminders r WHERE r.task_id=task_schedules.task_id)",
};

/** Scheduling purge statements (§5.6). Schedules, reminders, occurrences, outbox rows, notifications and schedule audit rows. */
export const schedulingPurgeContributor: PurgeContributor = {
  domain: "scheduling",
  statements: ({ userId, batchLimit }) =>
    tables.map((table) => {
      const id =
        table === "notification_prefs" ? "owner_id" : table === "task_schedules" ? "task_id" : "id";
      return sql(
        `DELETE FROM ${table} WHERE ${id} IN (SELECT ${id} FROM ${table} WHERE owner_id=:owner ${children[table] ?? ""} LIMIT :limit)`,
        { owner: userId, limit: int(batchLimit) },
      );
    }),
  remaining: ({ userId }) =>
    tables.map((table) =>
      sql(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE owner_id=:owner) AS remaining`, {
        owner: userId,
      }),
    ),
};
