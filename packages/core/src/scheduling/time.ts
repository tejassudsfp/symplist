import type {
  SchedulingDeadline,
  SchedulingPreferences,
  SchedulingRule,
} from "@symplist/contracts";
import { Temporal } from "temporal-polyfill";

export class SchedulingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SchedulingError";
  }
}

export function resolveLocal(
  local: string,
  zone: string,
  choice: "reject" | "earlier" | "later" = "reject",
): number {
  try {
    const plain = Temporal.PlainDateTime.from(local);
    const earlier = plain.toZonedDateTime(zone, { disambiguation: "earlier" });
    const later = plain.toZonedDateTime(zone, { disambiguation: "later" });
    if (earlier.epochMilliseconds !== later.epochMilliseconds && choice === "reject")
      throw new SchedulingError("schedule.dst_choice");
    return (choice === "earlier" ? earlier : later).epochMilliseconds;
  } catch (error) {
    if (error instanceof SchedulingError) throw error;
    throw new SchedulingError("schedule.invalid_time");
  }
}

export function deadlineInstant(deadline: SchedulingDeadline | null): number | null {
  if (!deadline) return null;
  if (deadline.kind === "timed")
    return resolveLocal(deadline.local, deadline.zone, deadline.disambiguation);
  try {
    return Temporal.PlainDate.from(deadline.date).add({ days: 1 }).toZonedDateTime(deadline.zone)
      .epochMilliseconds;
  } catch {
    throw new SchedulingError("schedule.invalid_time");
  }
}

export function localHour(instant: number, zone: string): number {
  return Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(zone).hour;
}

export function isQuiet(instant: number, preferences: SchedulingPreferences): boolean {
  if (!preferences.quietEnabled) return false;
  const hour = localHour(instant, preferences.zone);
  return preferences.quietStart < preferences.quietEnd
    ? hour >= preferences.quietStart && hour < preferences.quietEnd
    : hour >= preferences.quietStart || hour < preferences.quietEnd;
}

/** Calendar-hour arithmetic preserves quarter-hour offsets and steps safely across DST gaps. */
export function afterQuiet(instant: number, preferences: SchedulingPreferences): number {
  let time = Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(preferences.zone);
  if (!isQuiet(instant, preferences)) return instant;
  time = time.round({ smallestUnit: "hour", roundingMode: "floor" });
  for (
    let i = 0;
    i < 50 && (time.epochMilliseconds < instant || isQuiet(time.epochMilliseconds, preferences));
    i++
  )
    time = time.add({ hours: 1 });
  return time.epochMilliseconds;
}

export function reminderInstant(rule: SchedulingRule, deadline: SchedulingDeadline | null): number {
  let instant: number;
  let zone: string;
  if (rule.kind === "absolute") {
    instant = resolveLocal(rule.local, rule.zone, rule.disambiguation);
    zone = rule.zone;
  } else {
    if (!deadline) throw new SchedulingError("schedule.deadline_required");
    zone = deadline.zone;
    if (rule.kind === "elapsed") {
      if (deadline.kind !== "timed") throw new SchedulingError("schedule.deadline_required");
      instant =
        resolveLocal(deadline.local, zone, deadline.disambiguation) - rule.minutesBefore * 60_000;
    } else {
      try {
        const date = Temporal.PlainDate.from(
          deadline.kind === "date" ? deadline.date : deadline.local.slice(0, 10),
        ).subtract({ days: rule.daysBefore });
        instant = resolveLocal(`${date}T${String(rule.hour).padStart(2, "0")}:00`, zone);
      } catch (error) {
        if (error instanceof SchedulingError) throw error;
        throw new SchedulingError("schedule.invalid_time");
      }
    }
  }
  return Temporal.Instant.fromEpochMilliseconds(instant)
    .toZonedDateTimeISO(zone)
    .round({ smallestUnit: "hour", roundingMode: "floor" }).epochMilliseconds;
}

export function previewReminder(
  rule: SchedulingRule,
  deadline: SchedulingDeadline | null,
  preferences: SchedulingPreferences,
  overrideQuiet: boolean,
) {
  const intendedAt = reminderInstant(rule, deadline);
  const emailAt = overrideQuiet ? intendedAt : afterQuiet(intendedAt, preferences);
  const due = deadlineInstant(deadline);
  return { intendedAt, emailAt, crossesDeadline: due !== null && emailAt > due };
}
