import { EmailValidationError } from "../errors.ts";

function inputError(message: string): EmailValidationError {
  return new EmailValidationError("email.invalid_template_input", message);
}

/** Throws unless `timeZone` is an IANA zone Intl recognizes. */
export function checkTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw inputError("timeZone must be a valid IANA time zone");
  }
  return timeZone;
}

function checkInstant(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw inputError(`${label} must be UTC epoch milliseconds`);
  }
  return value;
}

/** Intl inserts U+202F before AM/PM; plain spaces render reliably in every mail client. */
function normalizeSpaces(value: string): string {
  return value.replace(/[  ]/g, " ");
}

/** `Friday, September 18, 2026 at 5:00 PM (America/Los_Angeles)` */
export function formatInstant(at: number, timeZone: string, label = "instant"): string {
  checkInstant(at, label);
  checkTimeZone(timeZone);
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return `${normalizeSpaces(formatted)} (${timeZone})`;
}

const plainDate = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `Friday, September 18, 2026 (America/Los_Angeles)` for a date-only deadline (§12.1). */
export function formatPlainDate(date: string, timeZone: string): string {
  const match = plainDate.exec(date);
  if (!match) throw inputError("date must be YYYY-MM-DD");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utcNoon = Date.UTC(year, month - 1, day, 12);
  const check = new Date(utcNoon);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw inputError("date must be a real calendar date");
  }
  checkTimeZone(timeZone);
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(utcNoon);
  return `${normalizeSpaces(formatted)} (${timeZone})`;
}
