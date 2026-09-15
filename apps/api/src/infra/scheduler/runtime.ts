import { Logger } from "@nestjs/common";

/**
 * Time and logging ports shared by the realtime gateway, the internal endpoints, the executors and
 * the local scheduler. Tests pass `FakeClock` from `@symplist/testing`, which satisfies `RuntimeTimers`.
 */
export interface RuntimeTimers {
  /** UTC epoch milliseconds. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * Injection token for the {@link RuntimeTimers} of the realtime gateway, internal endpoints, executors
 * and local scheduler: real timers in production, the test's `FakeClock` under the harness.
 */
export const RUNTIME_TIMERS = "symplist:RUNTIME_TIMERS";

/** Whether a clock also schedules timers (a `FakeClock` does), so it can drive every runtime timer. */
export function isRuntimeTimers(value: unknown): value is RuntimeTimers {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["now", "setTimeout", "clearTimeout", "setInterval", "clearInterval"].every(
    (name) => typeof candidate[name] === "function",
  );
}

/** Real timers. Background timers are unreferenced so they never keep a process (or a CLI) alive. */
export const systemTimers: RuntimeTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, Math.max(0, delayMs)).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout | undefined),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs).unref(),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout | undefined),
};

/** Log field values: ids, stable codes, counts, durations and flags only (§6.3). */
export type OperationalLogFields = Readonly<Record<string, string | number | boolean | null>>;

/**
 * A structured operational log. `event` is a stable dotted code and `fields` carry only ids, codes,
 * counts and durations: never bodies, envelopes, plaintext, tokens or error messages (§6.3, §8.3).
 */
export interface OperationalLog {
  info(event: string, fields?: OperationalLogFields): void;
  warn(event: string, fields?: OperationalLogFields): void;
  error(event: string, fields?: OperationalLogFields): void;
}

/** An operational log that writes one JSON line per event through Nest's logger. */
export function nestOperationalLog(context: string): OperationalLog {
  const logger = new Logger(context);
  const line = (event: string, fields?: OperationalLogFields) =>
    JSON.stringify({ event, ...(fields ?? {}) });
  return {
    info: (event, fields) => logger.log(line(event, fields)),
    warn: (event, fields) => logger.warn(line(event, fields)),
    error: (event, fields) => logger.error(line(event, fields)),
  };
}

/** The stable code of any thrown value, without its message (§6.3). */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(code))
      return code;
  }
  return "internal";
}

/** The error class name of any thrown value, for logs (§6.3). */
export function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "Error";
}
