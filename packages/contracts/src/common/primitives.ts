import { z } from "zod";

/** UTC epoch milliseconds, the timestamp format used everywhere (architecture conventions). */
export const epochMillisSchema = z
  .number({ error: "Expected a UTC epoch milliseconds timestamp" })
  .int({ error: "Expected a UTC epoch milliseconds timestamp" })
  .nonnegative({ error: "Expected a UTC epoch milliseconds timestamp" });

export type EpochMillis = z.infer<typeof epochMillisSchema>;

/**
 * A monotonic non-negative integer: row versions, generations, counts and WebSocket sequence
 * numbers. Values stay within JavaScript's safe integer range.
 */
export const counterSchema = z
  .number({ error: "Expected a non-negative whole number" })
  .int({ error: "Expected a non-negative whole number" })
  .nonnegative({ error: "Expected a non-negative whole number" });

export type Counter = z.infer<typeof counterSchema>;

/**
 * Stable dotted identifiers such as error codes (`task.archived`), notices
 * (`secret.already_issued`) and WebSocket event types (`share_grant.changed`).
 */
export const stableCodePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

/** Whether a value is a stable dotted identifier of at most 100 characters. */
export function isStableCode(value: string): boolean {
  return value.length <= 100 && stableCodePattern.test(value);
}

/** A stable error or notice code string; the composed index narrows it to the declared codes. */
export const stableCodeSchema = z
  .string({ error: "Expected a stable code" })
  .max(100, { error: "Expected a stable code" })
  .regex(stableCodePattern, { error: "Expected a stable code" });
