import { Buffer } from "node:buffer";
import type { Statement } from "./client.ts";
import { DbInvalidStatementError, DbLimitError } from "./errors.ts";
import { analyzeStatement, splitSqlStatements } from "./sql-lexer.ts";

/** D1 limits enforced by both clients before anything is sent (§3.2). */
export const D1_LIMITS = Object.freeze({
  /** Bound parameters per statement. */
  maxParams: 100,
  /** SQL text per statement, in UTF-8 bytes. */
  maxSqlBytes: 100_000,
  /** Bytes per bound value (strings, BLOBs and rows are capped at 2 MB). */
  maxValueBytes: 2_000_000,
  /** Every REST request is aborted after this long (Cloudflare API requests resolve within 30 s). */
  requestTimeoutMs: 35_000,
});

/** Tables whose rows may be inserted but never updated or deleted (§5.6). */
export const APPEND_ONLY_TABLES: readonly string[] = Object.freeze(["beta_admin_events"]);

export interface StatementCheck {
  /** Whether the statement only reads. */
  readonly readOnly: boolean;
}

/**
 * Validates one batch entry: size limits, string parameters, one statement, anonymous `?`
 * placeholders matching the parameter count, no transaction control, and no update or delete of an
 * append-only table. Throws before any request is made.
 */
export function checkStatement(
  statement: Statement,
  index: number,
  appendOnlyTables: readonly string[] = APPEND_ONLY_TABLES,
): StatementCheck {
  if (typeof statement?.sql !== "string" || !Array.isArray(statement.params)) {
    throw new DbInvalidStatementError(
      "db.invalid_statement",
      "Statement must have string SQL and a params array",
      index,
    );
  }
  if (Buffer.byteLength(statement.sql, "utf8") > D1_LIMITS.maxSqlBytes) {
    throw new DbLimitError("sql_bytes", index);
  }
  if (statement.params.length > D1_LIMITS.maxParams) {
    throw new DbLimitError("params", index);
  }
  for (const param of statement.params) {
    if (typeof param !== "string") {
      throw new DbInvalidStatementError(
        "db.invalid_statement",
        "Parameters must be strings; encode with int(), bool() or json() and write NULL literally",
        index,
      );
    }
    if (Buffer.byteLength(param, "utf8") > D1_LIMITS.maxValueBytes) {
      throw new DbLimitError("value_bytes", index);
    }
  }

  const analysis = analyzeStatement(statement.sql);
  if (analysis.statementCount === 0) throw new DbLimitError("statement_empty", index);
  if (analysis.statementCount > 1) {
    throw new DbInvalidStatementError(
      "db.invalid_statement",
      "A batch entry must contain exactly one statement",
      index,
    );
  }
  if (analysis.transactionControl) {
    throw new DbInvalidStatementError(
      "db.invalid_statement",
      "Transaction control and ATTACH are not allowed inside a batch",
      index,
    );
  }
  if (analysis.otherParameters.length > 0) {
    throw new DbInvalidStatementError(
      "db.invalid_statement",
      "Batch entries use anonymous ? placeholders; compile named parameters with sql()",
      index,
    );
  }
  if (analysis.anonymousParameters !== statement.params.length) {
    throw new DbInvalidStatementError(
      "db.invalid_statement",
      `Statement has ${analysis.anonymousParameters} placeholders but ${statement.params.length} params`,
      index,
    );
  }
  const protectedTables = new Set(appendOnlyTables.map((table) => table.toLowerCase()));
  for (const target of analysis.writeTargets) {
    const touchesProtected =
      target.operation === "drop_trigger"
        ? [...protectedTables].some((table) => target.name.startsWith(`${table}_`))
        : target.operation !== "insert" && protectedTables.has(target.name);
    if (touchesProtected) {
      throw new DbInvalidStatementError(
        "db.append_only",
        `${target.name} is append-only (${target.operation} rejected)`,
        index,
      );
    }
  }
  return { readOnly: analysis.readOnly };
}

/** Validates every entry of a batch; returns whether the whole batch only reads. */
export function checkBatch(
  statements: readonly Statement[],
  appendOnlyTables: readonly string[] = APPEND_ONLY_TABLES,
): { readonly readOnly: boolean } {
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new DbLimitError("batch_empty");
  }
  let readOnly = true;
  statements.forEach((statement, index) => {
    if (!checkStatement(statement, index, appendOnlyTables).readOnly) readOnly = false;
  });
  return { readOnly };
}

/**
 * Validates a migration script: non-empty, and every statement within the per-statement SQL limit
 * (a longer statement must be split, §3.4). Scripts carry no parameters.
 */
export function checkScript(sql: string): void {
  if (typeof sql !== "string") {
    throw new DbInvalidStatementError("db.invalid_statement", "Script must be a string");
  }
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) throw new DbLimitError("statement_empty");
  statements.forEach((statement, index) => {
    if (Buffer.byteLength(statement.text, "utf8") > D1_LIMITS.maxSqlBytes) {
      throw new DbLimitError("sql_bytes", index);
    }
  });
}
