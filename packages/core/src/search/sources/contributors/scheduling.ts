import { sql } from "@symplist/db";
import { Temporal } from "temporal-polyfill";
import { SearchServiceError } from "../../errors.ts";
import type { SearchSourceContributor } from "../types.ts";

/**
 * The scheduling search source (§12.1, note 14 deadline filters). It adds `deadlines`: a
 * `DeadlineFilterSource` over owner-scoped `task_schedules`, never a text index.
 */
export const schedulingSearchSourceContributor: SearchSourceContributor = {
  domain: "scheduling",
  deadlines: ({ db }) => ({
    async matchingTaskIds(owner, filter, now) {
      const params: Record<string, string> = { owner };
      let condition: string;
      switch (filter.kind) {
        case "has":
          condition = "s.deadline_kind IS NOT NULL";
          break;
        case "none":
          condition = "s.deadline_kind IS NULL";
          break;
        case "overdue":
          condition = "s.deadline_at<CAST(:now AS INTEGER)";
          params.now = String(now);
          break;
        case "due_today":
        case "range": {
          const today = Temporal.Instant.fromEpochMilliseconds(now)
            .toZonedDateTimeISO(filter.timeZone)
            .toPlainDate();
          const from = filter.kind === "range" ? Temporal.PlainDate.from(filter.from) : today;
          const to = filter.kind === "range" ? Temporal.PlainDate.from(filter.to) : today;
          params.from = String(from);
          params.to = String(to);
          params.start = String(from.toZonedDateTime(filter.timeZone).epochMilliseconds);
          params.end = String(
            to.add({ days: 1 }).toZonedDateTime(filter.timeZone).epochMilliseconds,
          );
          condition =
            "((s.deadline_kind='date' AND s.deadline_date>=:from AND s.deadline_date<=:to) OR (s.deadline_kind='timed' AND s.deadline_at>=CAST(:start AS INTEGER) AND s.deadline_at<CAST(:end AS INTEGER)))";
        }
      }
      const rows = await db.all(
        sql(
          `SELECT t.id FROM tasks t LEFT JOIN task_schedules s ON s.task_id=t.id AND s.owner_id=t.owner_id WHERE t.owner_id=:owner AND ${condition} LIMIT 10001`,
          params,
        ),
      );
      if (rows.length > 10000) throw new SearchServiceError("search.unavailable");
      return new Set(rows.map((row) => String(row.id)));
    },
  }),
};
