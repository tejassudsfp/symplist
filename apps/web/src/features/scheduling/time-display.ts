export function localDate(now: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}
export function deliveryLabel(instant: number, zone: string): string {
  return `${new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(instant)} · ${zone}`;
}
export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export const schedulingZones = ["UTC", ...Intl.supportedValuesOf("timeZone")];
export const schedulingHours = Array.from({ length: 24 }, (_, hour) => hour);

import { Temporal } from "temporal-polyfill";

export function daylightChoice(local: string, zone: string, choice: "earlier" | "later") {
  try {
    const time = Temporal.PlainDateTime.from(local).toZonedDateTime(zone, {
      disambiguation: choice,
    });
    return `${choice === "earlier" ? "Earlier" : "Later"}: ${time.toPlainDateTime().toString({ smallestUnit: "minute" })} (UTC${time.offset})`;
  } catch {
    return choice === "earlier" ? "Earlier" : "Later";
  }
}
