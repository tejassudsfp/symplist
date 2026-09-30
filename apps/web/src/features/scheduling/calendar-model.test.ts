import type { SchedulingCalendarItem } from "@symplist/contracts";
import { describe, expect, it } from "vitest";
import {
  addMonths,
  compareDeadlines,
  dayHeading,
  daysBetween,
  deadlineState,
  describeDay,
  gridDays,
  groupByDay,
  isCalendarDate,
  longDay,
  orderedDays,
  rangeOf,
  rangeTitle,
  readRange,
  stepName,
  timeLabel,
  unscheduledDay,
  weekdayIndex,
  weekdayNames,
  weeksOf,
} from "./calendar-model.ts";

function item(overrides: Partial<SchedulingCalendarItem> = {}): SchedulingCalendarItem {
  return {
    taskId: "019947aa-0000-7000-8000-000000000001",
    title: "Prepare outline",
    collection: "now",
    archived: false,
    deadline: { kind: "date", date: "2026-09-17", zone: "UTC" },
    deadlineAt: Date.parse("2026-09-17T18:15Z"),
    version: 1,
    ...overrides,
  };
}

describe("calendar date arithmetic", () => {
  it("treats Monday as the first column and measures whole days", () => {
    expect(weekdayIndex("2026-09-14")).toBe(0);
    expect(weekdayIndex("2026-09-20")).toBe(6);
    expect(daysBetween("2026-09-14", "2026-09-20")).toBe(6);
    expect(daysBetween("2026-09-20", "2026-09-14")).toBe(-6);
  });
  it("keeps month arithmetic on the first of the month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-01");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-01");
  });
  it("names a month or a Monday-anchored week as the range a view is about", () => {
    expect(rangeOf("month", "2026-09-17")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(rangeOf("agenda", "2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(rangeOf("week", "2026-09-17")).toEqual({ from: "2026-09-14", to: "2026-09-20" });
    expect(stepName("week")).toBe("week");
    expect(stepName("agenda")).toBe("month");
  });
  it("asks the api for every day the grid has a cell for, not just the month", () => {
    // The month grid completes the weeks September touches, so it draws 31 August and the first four
    // days of October. Reading only 1–30 September left those five cells blank however much was due on
    // them. The agenda is a list headed "September 2026", so it still asks for the month exactly.
    expect(readRange("month", "2026-09-17")).toEqual({ from: "2026-08-31", to: "2026-10-04" });
    expect(readRange("month", "2026-03-10")).toEqual({ from: "2026-02-23", to: "2026-04-05" });
    expect(readRange("week", "2026-09-17")).toEqual(rangeOf("week", "2026-09-17"));
    expect(readRange("agenda", "2026-09-17")).toEqual(rangeOf("agenda", "2026-09-17"));
    // Whatever the month, the range read is exactly the cells drawn — at most the six weeks a grid ever
    // spans, which is far inside the api's own range limit.
    for (const month of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]) {
      const anchor = `2026-${month}-10`;
      const days = gridDays("month", anchor);
      const span = readRange("month", anchor);
      expect([span.from, span.to]).toEqual([days[0], days.at(-1)]);
      expect(daysBetween(span.from, span.to) + 1).toBeLessThanOrEqual(42);
    }
  });
  it("draws only the weeks a month actually touches", () => {
    // September 2026 starts on a Tuesday and has 30 days: five weeks, not the six a fixed grid draws.
    const september = gridDays("month", "2026-09-17");
    expect(september).toHaveLength(35);
    expect(september[0]).toBe("2026-08-31");
    expect(september.at(-1)).toBe("2026-10-04");
    // February 2026 also fits in five even though it starts on a Sunday; March 2026 is the six-week
    // shape a fixed grid is built for, and the only shape it ever got right.
    expect(gridDays("month", "2026-02-10")).toHaveLength(35);
    expect(gridDays("month", "2026-03-10")).toHaveLength(42);
    expect(gridDays("week", "2026-09-17")).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
    ]);
  });
  it("splits the grid into rows of seven", () => {
    const weeks = weeksOf(gridDays("month", "2026-09-17"));
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
  });
  it("accepts only real calendar days from the url", () => {
    expect(isCalendarDate("2026-09-17")).toBe(true);
    expect(isCalendarDate("2026-99-99")).toBe(false);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
  });
});

describe("calendar labels", () => {
  it("names the range being shown rather than printing its bounds", () => {
    expect(rangeTitle("month", "2026-09-01", "2026-09-30")).toContain("September");
    expect(rangeTitle("month", "2026-09-01", "2026-09-30")).toContain("2026");
    const week = rangeTitle("week", "2026-08-31", "2026-09-06");
    expect(week).toContain("August");
    expect(week).toContain("September");
  });
  it("spells a day out and says where it sits relative to today", () => {
    expect(longDay("2026-09-17")).toContain("Thursday");
    expect(dayHeading("2026-09-17", "2026-09-17")).toMatch(/^Today · /);
    expect(dayHeading("2026-09-18", "2026-09-17")).toMatch(/^Tomorrow · /);
    expect(dayHeading("2026-09-16", "2026-09-17")).toMatch(/^Yesterday · /);
    expect(dayHeading("2026-09-25", "2026-09-17")).toBe(longDay("2026-09-25"));
  });
  it("counts a day's deadlines in the name a screen reader hears", () => {
    expect(describeDay("2026-09-17", 0)).toBe(`${longDay("2026-09-17")}, no deadlines`);
    expect(describeDay("2026-09-17", 1)).toBe(`${longDay("2026-09-17")}, 1 deadline`);
    expect(describeDay("2026-09-17", 3)).toBe(`${longDay("2026-09-17")}, 3 deadlines`);
  });
  it("names the seven columns in the grid's own order", () => {
    const names = weekdayNames();
    expect(names).toHaveLength(7);
    expect(names[0]?.long).toBe("Monday");
    expect(names[6]?.long).toBe("Sunday");
    expect(names[0]?.short.length).toBeGreaterThan(0);
  });
  it("shows a timed deadline as a clock time in the viewer's zone", () => {
    const instant = Date.parse("2026-09-17T18:15Z");
    expect(timeLabel(instant, "UTC")).toMatch(/6:15|18:15/);
    expect(timeLabel(instant, "Asia/Kathmandu")).not.toBe(timeLabel(instant, "UTC"));
  });
});

describe("calendar grouping", () => {
  it("places an all-day deadline on its own day and a timed one in the viewer's zone", () => {
    const allDay = item({
      taskId: "a",
      deadline: { kind: "date", date: "2026-09-17", zone: "UTC" },
    });
    const lateNight = item({
      taskId: "b",
      deadline: { kind: "timed", local: "2026-09-17T23:30", zone: "UTC", disambiguation: "reject" },
      deadlineAt: Date.parse("2026-09-17T23:30Z"),
    });
    const grouped = groupByDay([allDay, lateNight], "Asia/Kathmandu");
    expect(grouped.get("2026-09-17")?.map((entry) => entry.taskId)).toEqual(["a"]);
    expect(grouped.get("2026-09-18")?.map((entry) => entry.taskId)).toEqual(["b"]);
  });
  it("keeps tasks with no deadline in their own group, ordered last", () => {
    const undated = item({ taskId: "c", deadline: null, deadlineAt: null });
    const grouped = groupByDay([undated, item({ taskId: "a" })], "UTC");
    expect(grouped.get(unscheduledDay)?.map((entry) => entry.taskId)).toEqual(["c"]);
    expect(orderedDays(grouped).map(([day]) => day)).toEqual(["2026-09-17", unscheduledDay]);
  });
  it("orders a day with all-day first, then by time, then by title", () => {
    const morning = item({
      taskId: "b",
      title: "B",
      deadline: { kind: "timed", local: "2026-09-17T09:00", zone: "UTC", disambiguation: "reject" },
      deadlineAt: Date.parse("2026-09-17T09:00Z"),
    });
    const evening = item({
      taskId: "c",
      title: "C",
      deadline: { kind: "timed", local: "2026-09-17T21:00", zone: "UTC", disambiguation: "reject" },
      deadlineAt: Date.parse("2026-09-17T21:00Z"),
    });
    const allDay = item({ taskId: "a", title: "A" });
    const grouped = groupByDay([evening, morning, allDay], "UTC");
    expect(grouped.get("2026-09-17")?.map((entry) => entry.title)).toEqual(["A", "B", "C"]);
    expect(compareDeadlines(morning, { ...morning, title: "Z" })).toBeLessThan(0);
  });
  it("reads completed and overdue ahead of the kind of deadline", () => {
    const now = Date.parse("2026-09-20T00:00Z");
    expect(deadlineState(item({ archived: true }), now)).toBe("completed");
    expect(deadlineState(item(), now)).toBe("overdue");
    expect(deadlineState(item({ deadlineAt: Date.parse("2026-09-30T09:00Z") }), now)).toBe(
      "all_day",
    );
    expect(
      deadlineState(
        item({
          deadline: {
            kind: "timed",
            local: "2026-09-30T09:00",
            zone: "UTC",
            disambiguation: "reject",
          },
          deadlineAt: Date.parse("2026-09-30T09:00Z"),
        }),
        now,
      ),
    ).toBe("timed");
    expect(deadlineState(item({ deadline: null, deadlineAt: null }), now)).toBe("none");
  });
});
