/**
 * One SQL statement. Parameters are always strings: helpers encode numbers and booleans, absent
 * values become SQL `NULL` literals and JSON is bound as a string (§3.2).
 */
export interface Statement {
  readonly sql: string;
  readonly params: readonly string[];
}

/** A D1 value as returned in result rows. */
export type DbValue = string | number | null;

/** A result row keyed by column name. */
export type DbRow = Record<string, DbValue>;

/** Per-statement metadata in the D1 REST envelope. Decisions never read `changes` or `last_row_id` (§3.2). */
export interface StatementMeta {
  readonly changes?: number;
  readonly last_row_id?: number;
  readonly duration?: number;
  readonly rows_read?: number;
  readonly rows_written?: number;
}

/** The result of one statement in a batch, in the D1 REST envelope shape. */
export interface StatementResult<Row extends DbRow = DbRow> {
  readonly success: boolean;
  readonly results: readonly Row[];
  readonly meta: StatementMeta;
}

/**
 * Data access for D1 (REST) and the local `node:sqlite` stand-in. `batch` is one request executed in
 * order; every multi-statement logical write is one `batch` call (§3.2).
 */
export interface DbClient {
  batch(statements: readonly Statement[]): Promise<readonly StatementResult[]>;
  /** Runs one statement and returns its rows. */
  all<Row extends DbRow = DbRow>(statement: Statement): Promise<readonly Row[]>;
  /** Runs one statement and returns its first row, or null. */
  first<Row extends DbRow = DbRow>(statement: Statement): Promise<Row | null>;
  /** Runs one statement and returns its result. */
  run(statement: Statement): Promise<StatementResult>;
}
