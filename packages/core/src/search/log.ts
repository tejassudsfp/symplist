/** Log field values: ids, stable codes, counts, durations and flags only (§6.3, §8.3). */
export type SearchLogFields = Readonly<Record<string, string | number | boolean | null>>;

/**
 * The structured log search writes to. Events are stable dotted codes; fields never carry queries,
 * titles, snippets, document text, keys or error messages. The api's operational log and the worker's
 * redacting logger both satisfy it.
 */
export interface SearchLog {
  info(event: string, fields?: SearchLogFields): void;
  warn(event: string, fields?: SearchLogFields): void;
  error(event: string, fields?: SearchLogFields): void;
}

/** A log that discards everything. */
export const silentSearchLog: SearchLog = Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

/** The stable code of a thrown value, never its message. */
export function searchErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (
      typeof code === "string" &&
      /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(code) &&
      code.length <= 64
    ) {
      return code;
    }
  }
  return "internal";
}
