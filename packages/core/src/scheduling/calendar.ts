import type { SchedulingCalendarItem, schedulingCalendarQuerySchema } from "@symplist/contracts";
import { decryptFieldText, zeroize } from "@symplist/crypto";
import { sql } from "@symplist/db";
import { Temporal } from "temporal-polyfill";
import { taskTitleContext } from "../tasks/sql.ts";
import { deadlineFromRow, type SchedulingService } from "./service.ts";
import { SchedulingError } from "./time.ts";

export async function calendarTasks(
  service: SchedulingService,
  owner: string,
  query: typeof schedulingCalendarQuerySchema._output,
): Promise<{ items: SchedulingCalendarItem[]; nextCursor: string | null }> {
  let from: Temporal.PlainDate;
  let to: Temporal.PlainDate;
  try {
    from = Temporal.PlainDate.from(query.from);
    to = Temporal.PlainDate.from(query.to);
  } catch {
    throw new SchedulingError("schedule.invalid_time");
  }
  if (from.until(to).days < 0 || from.until(to).days > 366)
    throw new SchedulingError("schedule.invalid_time");
  const conditions = ["t.owner_id=:owner", service.access()];
  const params: Record<string, string> = { owner };
  if (query.archived !== "true") conditions.push("t.status='active'");
  if (query.collection !== "all") {
    conditions.push("t.collection=:collection");
    params.collection = query.collection;
  }
  if (query.cursor) {
    conditions.push("t.id>:cursor");
    params.cursor = query.cursor;
  }
  if (query.unscheduled === "true") conditions.push("s.deadline_kind IS NULL");
  else {
    conditions.push(
      "((s.deadline_kind='date' AND s.deadline_date>=:fromDate AND s.deadline_date<=:toDate) OR (s.deadline_kind='timed' AND s.deadline_at>=CAST(:fromAt AS INTEGER) AND s.deadline_at<CAST(:toAt AS INTEGER)))",
    );
    params.fromDate = String(from);
    params.toDate = String(to);
    params.fromAt = String(from.toZonedDateTime(query.zone).epochMilliseconds);
    params.toAt = String(to.add({ days: 1 }).toZonedDateTime(query.zone).epochMilliseconds);
  }
  const [rows, keys] = await service.options.db.batch([
    sql(
      `SELECT t.id,t.title_enc,t.collection,t.status,s.* FROM tasks t LEFT JOIN task_schedules s ON s.task_id=t.id AND s.owner_id=t.owner_id WHERE ${conditions.join(" AND ")} ORDER BY t.id LIMIT 201`,
      params,
    ),
    service.accountKeys.selectStatement(owner),
  ]);
  if (!keys?.results[0]) throw new SchedulingError("not_found");
  const key = service.accountKeys.unwrapRow(keys.results[0]);
  try {
    const all = rows?.results ?? [];
    const items: SchedulingCalendarItem[] = all.slice(0, 200).map((row) => ({
      taskId: String(row.id),
      title: decryptFieldText(key, taskTitleContext(owner, String(row.id)), String(row.title_enc)),
      collection: row.collection as SchedulingCalendarItem["collection"],
      archived: row.status === "archived",
      deadline: deadlineFromRow(row),
      deadlineAt: row.deadline_at as number | null,
      version: Number(row.version ?? 0),
    }));
    return { items, nextCursor: all.length > 200 ? (items.at(-1)?.taskId ?? null) : null };
  } finally {
    zeroize(key.key);
  }
}
