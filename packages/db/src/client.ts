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
 * Who a request serves. On the api lane, `unauthenticated` work (lookup, signup, OTP, invite
 * redeem, share reads, `/mcp` credential checks, `/oauth/*`) may use at most 30% of the bucket and
 * is shed first with `rate.limited` (§3.1).
 */
export type RequestPriority = "authenticated" | "unauthenticated";

export interface BatchOptions {
  /** Defaults to `authenticated`. */
  readonly priority?: RequestPriority;
  /** Aborts waiting for the lane or the request itself. */
  readonly signal?: AbortSignal;
  /**
   * Read-only batches only: use D1's `/raw` endpoint, which returns rows as arrays and is cheaper
   * for large results. Rows are still returned keyed by column name.
   */
  readonly raw?: boolean;
}

/**
 * Data access for D1 (REST) and the local `node:sqlite` stand-in. `batch` is one request executed in
 * order; every multi-statement logical write is one `batch` call (§3.2).
 */
export interface DbClient {
  batch(
    statements: readonly Statement[],
    options?: BatchOptions,
  ): Promise<readonly StatementResult[]>;
  /** Runs one statement and returns its rows. */
  all<Row extends DbRow = DbRow>(
    statement: Statement,
    options?: BatchOptions,
  ): Promise<readonly Row[]>;
  /** Runs one statement and returns its first row, or null. */
  first<Row extends DbRow = DbRow>(
    statement: Statement,
    options?: BatchOptions,
  ): Promise<Row | null>;
  /** Runs one statement and returns its result. */
  run(statement: Statement, options?: BatchOptions): Promise<StatementResult>;
}

/**
 * A client that can also run a multi-statement SQL script as one request. Reserved for migrations
 * (§3.2, §3.4): the REST client sends `{ sql }` and the local client runs the script inside one
 * `BEGIN IMMEDIATE` transaction.
 */
export interface MigrationTarget extends DbClient {
  executeScript(sql: string, options?: Pick<BatchOptions, "signal">): Promise<void>;
}
