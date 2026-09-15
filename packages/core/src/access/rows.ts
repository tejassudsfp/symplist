import type { DbRow } from "@symplist/db";

/** A row read by an access feature service did not have the shape its schema guarantees. */
export class AccessFeatureRowError extends Error {
  readonly code = "access.row_invalid";
  constructor(column: string) {
    super(`Unexpected value in ${column}`);
    this.name = "AccessFeatureRowError";
  }
}

export function textColumn(row: DbRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new AccessFeatureRowError(column);
  return value;
}

export function nullableTextColumn(row: DbRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new AccessFeatureRowError(column);
  return value;
}

export function integerColumn(row: DbRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AccessFeatureRowError(column);
  }
  return value;
}

export function nullableIntegerColumn(row: DbRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return integerColumn(row, column);
}

export function enumColumn<const Value extends string>(
  row: DbRow,
  column: string,
  values: readonly Value[],
): Value {
  const value = row[column];
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new AccessFeatureRowError(column);
  }
  return value as Value;
}

/** Parses a stored JSON object column; null for NULL or a value that is not an object. */
export function jsonObjectColumn(row: DbRow, column: string): Record<string, unknown> | null {
  const value = row[column];
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** An opaque `(createdAt, id)` list cursor, base64url JSON (§ pagination contract). */
export interface ListCursor {
  readonly t: number;
  readonly i: string;
}

export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify([cursor.t, cursor.i]), "utf8").toString("base64url");
}

/** Decodes a cursor this service issued; anything else reads as the first page. */
export function decodeCursor(value: string | undefined): ListCursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "number" &&
      Number.isSafeInteger(parsed[0]) &&
      typeof parsed[1] === "string" &&
      /^[0-9a-f-]{36}$/.test(parsed[1])
    ) {
      return { t: parsed[0], i: parsed[1] };
    }
  } catch {
    // Fall through: an unreadable cursor restarts the list.
  }
  return null;
}

/** Escapes `%`, `_` and `\` for a `LIKE … ESCAPE '\'` pattern that matches `text` anywhere. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}
