import { schedulingDefaultPreferences } from "@symplist/contracts";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import {
  afterQuiet,
  deadlineInstant,
  isQuiet,
  previewReminder,
  reminderInstant,
  resolveLocal,
} from "./time.ts";

describe("local-hour scheduling", () => {
  it("keeps a date-only deadline until the next local day, including a short DST day", () => {
    expect(deadlineInstant({ kind: "date", date: "2026-03-08", zone: "America/New_York" })).toBe(
      Date.parse("2026-03-09T04:00Z"),
    );
  });
  it.each(["2026-03-08T02:30", "2026-11-01T01:30"])("requires a DST choice for %s", (local) => {
    expect(() => resolveLocal(local, "America/New_York")).toThrow("schedule.dst_choice");
    expect(
      resolveLocal(local, "America/New_York", "later") -
        resolveLocal(local, "America/New_York", "earlier"),
    ).toBe(3600000);
  });
  it("rejects invalid dates and zones", () => {
    expect(() => resolveLocal("2026-02-31T09:00", "UTC")).toThrow("schedule.invalid_time");
    expect(() => resolveLocal("2026-01-01T09:00", "Made/Up")).toThrow("schedule.invalid_time");
  });
  it("rounds relative elapsed reminders down and retains Nepal's offset", () => {
    expect(
      reminderInstant(
        { kind: "elapsed", minutesBefore: 60 },
        {
          kind: "timed",
          local: "2026-09-17T10:40",
          zone: "Asia/Kathmandu",
          disambiguation: "reject",
        },
      ),
    ).toBe(Date.parse("2026-09-17T03:15Z"));
  });
  it("uses calendar days rather than elapsed 24 hours for previous-day reminders", () => {
    expect(
      reminderInstant(
        { kind: "calendar", daysBefore: 1, hour: 9 },
        {
          kind: "timed",
          local: "2026-03-08T10:00",
          zone: "America/New_York",
          disambiguation: "reject",
        },
      ),
    ).toBe(Date.parse("2026-03-07T14:00Z"));
  });
  it("supports standalone reminders but requires a timed deadline for elapsed rules", () => {
    expect(
      reminderInstant(
        { kind: "absolute", local: "2026-09-17T10:59", zone: "UTC", disambiguation: "reject" },
        null,
      ),
    ).toBe(Date.parse("2026-09-17T10:00Z"));
    expect(() => reminderInstant({ kind: "elapsed", minutesBefore: 0 }, null)).toThrow(
      "schedule.deadline_required",
    );
  });
  it("previews quiet-hours deferral crossing a deadline and supports explicit override", () => {
    const deadline = {
      kind: "timed",
      local: "2026-09-17T23:00",
      zone: "UTC",
      disambiguation: "reject",
    } as const;
    const rule = { kind: "elapsed", minutesBefore: 0 } as const;
    expect(previewReminder(rule, deadline, schedulingDefaultPreferences, false)).toEqual({
      intendedAt: Date.parse("2026-09-17T23:00Z"),
      emailAt: Date.parse("2026-09-18T08:00Z"),
      crossesDeadline: true,
    });
    expect(
      previewReminder(rule, deadline, schedulingDefaultPreferences, true).crossesDeadline,
    ).toBe(false);
  });
  it("handles daytime quiet hours and disabled quiet hours", () => {
    const at = Date.parse("2026-09-17T12:00Z");
    const prefs = { ...schedulingDefaultPreferences, quietStart: 10, quietEnd: 14 };
    expect(isQuiet(at, prefs)).toBe(true);
    expect(afterQuiet(at, prefs)).toBe(Date.parse("2026-09-17T14:00Z"));
    expect(afterQuiet(at, { ...prefs, quietEnabled: false })).toBe(at);
  });
  it("the :00/:15/:30 scans reach every IANA local hour across a full year including DST", () => {
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      // Every UTC hour samples both sides of every transition, not only a zone's current offset.
      const start = Date.parse("2026-01-01T00:00Z");
      for (let hour = 0; hour < 365 * 24; hour++) {
        const zoned = Temporal.Instant.fromEpochMilliseconds(
          start + hour * 3600000,
        ).toZonedDateTimeISO(zone);
        const requiredMinute = (60 - zoned.minute) % 60;
        if (![0, 15, 30].includes(requiredMinute))
          throw new Error(`Scan misses ${zone} at ${zoned}`);
      }
    }
  }, 120000);
});
