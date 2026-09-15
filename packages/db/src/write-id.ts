import { randomFillSync } from "node:crypto";
import type { BatchOptions, DbClient, DbRow, Statement, StatementResult } from "./client.ts";
import { DbError } from "./errors.ts";
import { assertIdentifier, sql } from "./query.ts";

/** A UUIDv7 string: 48-bit Unix milliseconds, version 7, variant 10, 74 random bits. */
export function uuidv7(nowMs: number = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) {
    throw new RangeError("uuidv7 timestamp must be a 48-bit non-negative integer");
  }
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);
  let timestamp = nowMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A fresh write id for one conditional write attempt (§3.2). */
export function newWriteId(): string {
  return uuidv7();
}

export interface WriteGuardInput {
  /** The table whose row the deciding statement updates. */
  readonly table: string;
  /** The row id the deciding statement targets. */
  readonly id: string;
  /** Defaults to a fresh UUIDv7. */
  readonly writeId?: string;
  /** Defaults to `id`. */
  readonly idColumn?: string;
  /** Prefix for the guard's named parameters; defaults to `guard`. */
  readonly paramPrefix?: string;
}

/**
 * The §3.2 conditional-write pattern for one deciding `UPDATE`:
 *
 * ```ts
 * const guard = writeGuard({ table: "users", id: userId });
 * const results = await db.batch([
 *   sql(`UPDATE users SET deletion_state = 'deleting', write_id = :w
 *        WHERE id = :user AND deletion_state = 'none'`, { w: guard.writeId, user: userId }),
 *   sql(`UPDATE account_delete_authorizations SET consumed_at = :now
 *        WHERE id = :auth AND consumed_at IS NULL AND ${guard.exists}`,
 *       { now, auth, ...guard.params }),
 *   guard.verify(),
 * ]);
 * const decided = verifiedRow(results) !== null;
 * ```
 *
 * The decision comes from the verification `SELECT`, never from `meta.changes` or `RETURNING`.
 */
export interface WriteGuard {
  readonly table: string;
  readonly id: string;
  readonly writeId: string;
  /** `EXISTS (…)` fragment for dependent statements, using the named parameters in `params`. */
  readonly exists: string;
  /** Named parameters referenced by `exists`. */
  readonly params: Readonly<Record<string, string>>;
  /** The verification `SELECT` that ends the batch; returns the row only if this write committed. */
  verify(columns?: readonly string[]): Statement;
}

export function writeGuard(input: WriteGuardInput): WriteGuard {
  const table = assertIdentifier(input.table);
  const idColumn = assertIdentifier(input.idColumn ?? "id");
  const prefix = assertIdentifier(input.paramPrefix ?? "guard");
  const writeId = input.writeId ?? newWriteId();
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new DbError("db.invalid_statement", "writeGuard requires a row id");
  }
  if (writeId.length === 0)
    throw new DbError("db.invalid_statement", "writeGuard requires a write id");
  const idParam = `${prefix}_id`;
  const writeParam = `${prefix}_write_id`;
  return {
    table,
    id: input.id,
    writeId,
    exists: `EXISTS (SELECT 1 FROM ${table} WHERE ${idColumn} = :${idParam} AND write_id = :${writeParam})`,
    params: { [idParam]: input.id, [writeParam]: writeId },
    verify(columns = [idColumn, "write_id"]) {
      const list = columns.map(assertIdentifier).join(", ");
      return sql(`SELECT ${list} FROM ${table} WHERE ${idColumn} = :id AND write_id = :write_id`, {
        id: input.id,
        write_id: writeId,
      });
    },
  };
}

export interface InsertVerificationInput {
  readonly table: string;
  /** The unique column the guarded `INSERT … SELECT` wrote, typically `request_id`. */
  readonly column: string;
  readonly value: string;
  /** Columns to return; defaults to the unique column. */
  readonly columns?: readonly string[];
}

/** The verification `SELECT` for a guarded `INSERT … SELECT`, by its unique request id (§3.2). */
export function verifyInsert(input: InsertVerificationInput): Statement {
  const table = assertIdentifier(input.table);
  const column = assertIdentifier(input.column);
  const list = (input.columns ?? [column]).map(assertIdentifier).join(", ");
  return sql(`SELECT ${list} FROM ${table} WHERE ${column} = :value`, { value: input.value });
}

/**
 * The row returned by a verification `SELECT` (the last statement unless `index` is given), or null
 * when the conditional write did not take effect.
 */
export function verifiedRow<Row extends DbRow = DbRow>(
  results: readonly StatementResult[],
  index: number = results.length - 1,
): Row | null {
  const result = results[index];
  if (!result) {
    throw new DbError("db.invalid_statement", `No verification result at statement ${index}`);
  }
  if (result.results.length > 1) {
    throw new DbError(
      "db.invalid_statement",
      `Verification statement ${index} returned more than one row`,
    );
  }
  return (result.results[0] as Row | undefined) ?? null;
}

/**
 * Resolves an unknown write outcome (§3.1) by reading the row's current write id. Reads may be
 * retried by the transport; the write itself is never resent.
 */
export async function reconcileWrite(
  db: DbClient,
  input: {
    readonly table: string;
    readonly id: string;
    readonly writeId: string;
    readonly idColumn?: string;
  },
  options?: BatchOptions,
): Promise<boolean> {
  const table = assertIdentifier(input.table);
  const idColumn = assertIdentifier(input.idColumn ?? "id");
  const row = await db.first(
    sql(`SELECT write_id FROM ${table} WHERE ${idColumn} = :id`, { id: input.id }),
    options,
  );
  return row?.write_id === input.writeId;
}
