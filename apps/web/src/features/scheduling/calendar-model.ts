import type { SchedulingCalendarItem } from "@symplist/contracts";
import { localDate, shiftDate } from "./time-display.ts";

/**
 * The calendar's date arithmetic and labels, kept out of the component so both can be read on their
 * own (§12, task_schedule.md). Every date is an ISO `YYYY-MM-DD` day in the viewer's zone, anchored at
 * noon UTC when it has to become a `Date`, so a shift never lands on a daylight-saving seam. Labels go
 * through `Intl` with the viewer's locale — the grid is Monday-first, which is the one thing here the
 * locale does not decide (§12).
 */
export type CalendarView = "month" | "week" | "agenda";

export const calendarViews: readonly CalendarView[] = ["month", "week", "agenda"];

/** The day the grid groups items under when a task has no deadline at all. */
export const unscheduledDay = "unscheduled";

const dayMs = 86_400_000;

function noon(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function format(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...options }).format(noon(date));
}

/** Monday-first weekday index (Monday 0 … Sunday 6). */
export function weekdayIndex(date: string): number {
  return (noon(date).getUTCDay() + 6) % 7;
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((noon(to).getTime() - noon(from).getTime()) / dayMs);
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function addMonths(date: string, count: number): string {
  const value = noon(monthStart(date));
  value.setUTCMonth(value.getUTCMonth() + count, 1);
  return value.toISOString().slice(0, 10);
}

/**
 * The inclusive range a view is *about*: the week it shows, or the month it is anchored in, which is
 * what names it in the title. It is not what the api is asked for — see `readRange`, which for a month
 * is wider than the month.
 */
export function rangeOf(view: CalendarView, date: string): { from: string; to: string } {
  if (view === "week") {
    const from = shiftDate(date, -weekdayIndex(date));
    return { from, to: shiftDate(from, 6) };
  }
  const from = monthStart(date);
  return { from, to: shiftDate(addMonths(from, 1), -1) };
}

/**
 * The first and last day the grid has a cell for: the week itself for a week, and for a month exactly
 * as many whole weeks as the month touches (four to six). The old grid was always six rows, so most
 * months ended in a row of greyed-out days from the next month.
 */
export function gridSpan(view: CalendarView, date: string): { from: string; to: string } {
  const { from, to } = rangeOf(view, date);
  if (view === "week") return { from, to };
  const start = shiftDate(from, -weekdayIndex(from));
  const weeks = Math.ceil((daysBetween(start, to) + 1) / 7);
  return { from: start, to: shiftDate(start, weeks * 7 - 1) };
}

/** The days the grid draws, in order. */
export function gridDays(view: CalendarView, date: string): readonly string[] {
  const { from, to } = gridSpan(view, date);
  return Array.from({ length: daysBetween(from, to) + 1 }, (_, index) => shiftDate(from, index));
}

/**
 * The inclusive range the api is actually asked for.
 *
 * For a grid it is the span the grid *draws*, which for a month is not the month: the grid completes
 * the weeks the month touches, so up to eleven of its cells belong to the months either side. Asking
 * only for the month left every one of those cells blank however much was due on it — and told a screen
 * reader they had "no deadlines" — so a person stepping from the end of September into October saw the
 * first days of October empty until the range caught up. The agenda is a list titled by its month, so
 * it keeps asking for the month exactly; spilling a neighbouring day into it would contradict the
 * heading. The widest a grid ever asks for is six weeks, far inside the api's own range limit.
 */
export function readRange(view: CalendarView, date: string): { from: string; to: string } {
  return view === "agenda" ? rangeOf(view, date) : gridSpan(view, date);
}

/** The grid's days in rows of seven. */
export function weeksOf(days: readonly string[]): readonly (readonly string[])[] {
  return Array.from({ length: Math.ceil(days.length / 7) }, (_, week) =>
    days.slice(week * 7, week * 7 + 7),
  );
}

/** Monday-first weekday names for the column headers, in the viewer's locale. */
export function weekdayNames(): readonly { readonly short: string; readonly long: string }[] {
  // 2024-01-01 was a Monday, so seven days from it name the week in the grid's own order.
  return Array.from({ length: 7 }, (_, index) => {
    const day = shiftDate("2024-01-01", index);
    return { short: format(day, { weekday: "short" }), long: format(day, { weekday: "long" }) };
  });
}

/** What Previous and Next move by, for their labels. */
export function stepName(view: CalendarView): "week" | "month" {
  return view === "week" ? "week" : "month";
}

/** The range shown, as a title: "September 2026", or "September 14 – 20, 2026" for a week. */
export function rangeTitle(view: CalendarView, from: string, to: string): string {
  if (view !== "week") return format(from, { month: "long", year: "numeric" });
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatRange(noon(from), noon(to));
}

/** A full spoken date: "Thursday, September 17, 2026". */
export function longDay(date: string): string {
  return format(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/** A day heading that says where the day sits relative to today before naming it. */
export function dayHeading(date: string, today: string): string {
  const offset = daysBetween(today, date);
  const relative =
    offset === 0 ? "Today" : offset === 1 ? "Tomorrow" : offset === -1 ? "Yesterday" : null;
  return relative ? `${relative} · ${longDay(date)}` : longDay(date);
}

/** The accessible name of a day cell's button: the date, then what is due on it. */
export function describeDay(date: string, count: number): string {
  if (count === 0) return `${longDay(date)}, no deadlines`;
  return `${longDay(date)}, ${count} deadline${count === 1 ? "" : "s"}`;
}

/** Just the clock part of a timed deadline, for a month cell: "6:15 PM". */
export function timeLabel(instant: number, zone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: zone, timeStyle: "short" }).format(instant);
}

export type DeadlineState = "completed" | "overdue" | "timed" | "all_day" | "none";

/** How an item reads on the grid: completed and overdue outrank the kind of deadline it has. */
export function deadlineState(item: SchedulingCalendarItem, now: number): DeadlineState {
  if (item.archived) return "completed";
  if (item.deadlineAt !== null && item.deadlineAt < now) return "overdue";
  if (item.deadline?.kind === "date") return "all_day";
  return item.deadlineAt === null ? "none" : "timed";
}

/** All-day deadlines lead the day, then timed ones in order; titles break ties so rows never jitter. */
export function compareDeadlines(a: SchedulingCalendarItem, b: SchedulingCalendarItem): number {
  const kind = (a.deadline?.kind === "date" ? 0 : 1) - (b.deadline?.kind === "date" ? 0 : 1);
  if (kind !== 0) return kind;
  const at = (a.deadlineAt ?? 0) - (b.deadlineAt ?? 0);
  return at !== 0 ? at : a.title.localeCompare(b.title);
}

/**
 * Items keyed by the day they are due in the viewer's zone. An all-day deadline is already a day in
 * its own zone, so it is used as it stands; a timed one is placed on the day the viewer experiences.
 */
export function groupByDay(
  items: readonly SchedulingCalendarItem[],
  zone: string,
): Map<string, SchedulingCalendarItem[]> {
  const byDay = new Map<string, SchedulingCalendarItem[]>();
  for (const item of items) {
    const day =
      item.deadline?.kind === "date"
        ? item.deadline.date
        : item.deadlineAt !== null
          ? localDate(item.deadlineAt, zone)
          : unscheduledDay;
    const existing = byDay.get(day);
    if (existing) existing.push(item);
    else byDay.set(day, [item]);
  }
  for (const list of byDay.values()) list.sort(compareDeadlines);
  return byDay;
}

/** The grouped days in date order, with undated tasks last. */
export function orderedDays(
  byDay: ReadonlyMap<string, readonly SchedulingCalendarItem[]>,
): readonly (readonly [string, readonly SchedulingCalendarItem[]])[] {
  return [...byDay.entries()].sort(([a], [b]) =>
    a === unscheduledDay ? 1 : b === unscheduledDay ? -1 : a.localeCompare(b),
  );
}

/** Whether a URL `?date=` parameter is a real calendar day. */
export function isCalendarDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = noon(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
