/** Dates in the person's locale; epoch milliseconds in, readable text out. */

export function formatDate(epochMs: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(epochMs);
}

export function formatDateTime(epochMs: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(epochMs);
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for a date input, in local time. */
export function toDateInputValue(epochMs: number): string {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The last millisecond of a `YYYY-MM-DD` local date, or null when the text is not a date. */
export function endOfLocalDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999);
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null;
  }
  return date.getTime();
}

export function addDays(epochMs: number, days: number): number {
  return epochMs + days * DAY_MS;
}
