import { DocumentError } from "../errors.ts";

/**
 * Opaque pagination cursors (§9.4, contracts `cursorSchema`): base64url JSON of at most 512
 * characters. Every cursor names its kind and the task it pages, and is validated field by field when
 * it comes back, so a cursor of another kind, task or shape is refused before any work. Cursors carry
 * only ids, revisions, offsets and short digests, never document text.
 */

export type CursorValue = string | number;

export interface CursorFieldSpec {
  readonly [field: string]: "revision" | "optional_revision" | "offset" | "token";
}

export const MAX_CURSOR_LENGTH = 512;

const revisionPattern = /^[0-9a-f]{40}$/;
const tokenPattern = /^[A-Za-z0-9_-]{1,64}$/;
const taskPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A cursor was malformed, of another kind, or for another task. */
export class CursorInvalidError extends DocumentError {
  constructor() {
    super("document.cursor_invalid");
    this.name = "CursorInvalidError";
  }
}

/** Encodes a cursor of `kind` for `taskId`. Throws when the result would exceed 512 characters. */
export function encodeCursor(
  kind: string,
  taskId: string,
  fields: Readonly<Record<string, CursorValue | null>>,
): string {
  const payload: Record<string, CursorValue | null> = { k: kind, t: taskId };
  for (const [name, value] of Object.entries(fields)) payload[name] = value;
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (encoded.length > MAX_CURSOR_LENGTH) throw new RangeError("Cursor too long");
  return encoded;
}

/**
 * Decodes and validates a cursor of `kind` for `taskId` against a field spec. Unknown fields, missing
 * fields, wrong kinds and wrong tasks all throw {@link CursorInvalidError}.
 */
export function decodeCursor<const Spec extends CursorFieldSpec>(
  cursor: string,
  kind: string,
  taskId: string,
  spec: Spec,
): {
  readonly [Field in keyof Spec]: Spec[Field] extends "offset"
    ? number
    : Spec[Field] extends "optional_revision"
      ? string | null
      : string;
} {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw new CursorInvalidError();
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new CursorInvalidError();
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new CursorInvalidError();
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CursorInvalidError();
  }
  const record = payload as Record<string, unknown>;
  if (record.k !== kind || record.t !== taskId || !taskPattern.test(taskId)) {
    throw new CursorInvalidError();
  }
  const allowed = new Set(["k", "t", ...Object.keys(spec)]);
  if (Object.keys(record).some((name) => !allowed.has(name))) throw new CursorInvalidError();
  const result: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(spec)) {
    const value = record[name];
    switch (type) {
      case "revision":
        if (typeof value !== "string" || !revisionPattern.test(value)) {
          throw new CursorInvalidError();
        }
        break;
      case "optional_revision":
        if (value !== null && (typeof value !== "string" || !revisionPattern.test(value))) {
          throw new CursorInvalidError();
        }
        break;
      case "offset":
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          throw new CursorInvalidError();
        }
        break;
      case "token":
        if (typeof value !== "string" || !tokenPattern.test(value)) throw new CursorInvalidError();
        break;
    }
    result[name] = value;
  }
  return result as never;
}
