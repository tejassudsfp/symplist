import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { constants, DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  BatchOptions,
  DbRow,
  DbValue,
  MigrationTarget,
  Statement,
  StatementResult,
} from "./client.ts";
import {
  DbError,
  DbInvalidStatementError,
  DbStatementError,
  DbUnavailableError,
} from "./errors.ts";
import { APPEND_ONLY_TABLES, checkBatch, checkScript } from "./limits.ts";
import { abortedError } from "./rate-limit.ts";
import { tokenizeSql } from "./sql-lexer.ts";

export interface LocalSqliteClientOptions {
  /** Database file path, or `:memory:`. Parent directories are created. */
  readonly path: string;
  /** Environment checked for `NODE_ENV=production`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** SQLite busy timeout; defaults to 5 seconds (§3.2). */
  readonly busyTimeoutMs?: number;
  readonly appendOnlyTables?: readonly string[];
}

/** Default local database file for `DATA_DRIVER=local` (§16.1). */
export const DEFAULT_LOCAL_DATABASE_PATH = ".local-data/d1.sqlite";

const deniedInUserSql = new Set<number>([
  constants.SQLITE_TRANSACTION,
  constants.SQLITE_SAVEPOINT,
  constants.SQLITE_ATTACH,
  constants.SQLITE_DETACH,
]);

/** Whether SQL left over after SQLite compiled its first statement holds another statement. */
function hasTrailingStatement(sql: string, compiled: string): boolean {
  if (!sql.startsWith(compiled)) return true;
  return tokenizeSql(sql.slice(compiled.length)).some((token) => token.kind !== "semicolon");
}

function toRow(row: Record<string, unknown>): DbRow {
  const plain: DbRow = {};
  for (const [key, value] of Object.entries(row)) {
    plain[key] = typeof value === "bigint" ? Number(value) : (value as DbValue);
  }
  return plain;
}

function providerMessage(error: unknown): string {
  return error instanceof Error ? error.message : "SQLite error";
}

/**
 * The local and test stand-in for D1 (§3.2, decision A7): `node:sqlite` with WAL and a 5-second busy
 * timeout, one `BEGIN IMMEDIATE` transaction per batch, an authorizer that rejects transaction
 * control, `ATTACH` and writes to append-only tables inside statements, the same limits and
 * single-statement rules as the REST client, TEXT-bound parameters and REST-shaped results.
 */
export class LocalSqliteClient implements MigrationTarget {
  readonly path: string;
  private readonly database: DatabaseSync;
  private readonly appendOnlyTables: readonly string[];
  private readonly protectedTables: ReadonlySet<string>;
  private inUserSql = false;
  private enforceAppendOnly = true;
  private readonly totalChanges: StatementSync;
  private readonly lastRowId: StatementSync;
  private closed = false;

  constructor(options: LocalSqliteClientOptions) {
    const env = options.env ?? process.env;
    if (env.NODE_ENV === "production") {
      throw new DbError(
        "db.production_refused",
        "The local SQLite database is a development adapter and refuses NODE_ENV=production",
      );
    }
    this.path = options.path;
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.appendOnlyTables = options.appendOnlyTables ?? APPEND_ONLY_TABLES;
    this.protectedTables = new Set(this.appendOnlyTables.map((table) => table.toLowerCase()));
    this.database = new DatabaseSync(options.path, {
      timeout: options.busyTimeoutMs ?? 5_000,
      enableForeignKeyConstraints: true,
    });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.setAuthorizer((action, first) => {
      if (!this.inUserSql) return constants.SQLITE_OK;
      if (deniedInUserSql.has(action)) return constants.SQLITE_DENY;
      if (
        this.enforceAppendOnly &&
        (action === constants.SQLITE_UPDATE ||
          action === constants.SQLITE_DELETE ||
          action === constants.SQLITE_DROP_TABLE) &&
        typeof first === "string" &&
        this.protectedTables.has(first.toLowerCase())
      ) {
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    this.totalChanges = this.database.prepare("SELECT total_changes() AS n");
    this.lastRowId = this.database.prepare("SELECT last_insert_rowid() AS n");
  }

  /** The SQLite journal mode in effect (`wal` for file databases). */
  journalMode(): string {
    const row = this.database.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    return row?.journal_mode ?? "";
  }

  async batch(
    statements: readonly Statement[],
    options: BatchOptions = {},
  ): Promise<readonly StatementResult[]> {
    this.assertOpen();
    if (options.signal?.aborted) throw abortedError();
    const { readOnly } = checkBatch(statements, this.appendOnlyTables);
    if (options.raw && !readOnly) {
      throw new DbInvalidStatementError(
        "db.invalid_statement",
        "The /raw endpoint is for read-only batches",
      );
    }
    return this.transaction(() =>
      statements.map((statement, index) => this.executeStatement(statement, index)),
    );
  }

  async all<Row extends DbRow = DbRow>(
    statement: Statement,
    options?: BatchOptions,
  ): Promise<readonly Row[]> {
    const [result] = await this.batch([statement], options);
    return (result?.results ?? []) as readonly Row[];
  }

  async first<Row extends DbRow = DbRow>(
    statement: Statement,
    options?: BatchOptions,
  ): Promise<Row | null> {
    const rows = await this.all<Row>(statement, options);
    return rows[0] ?? null;
  }

  async run(statement: Statement, options?: BatchOptions): Promise<StatementResult> {
    const [result] = await this.batch([statement], options);
    if (!result) throw new DbError("db.statement_failed", "SQLite returned no result");
    return result;
  }

  /** Runs a migration script inside one `BEGIN IMMEDIATE` transaction (§3.4). */
  async executeScript(sql: string, options: Pick<BatchOptions, "signal"> = {}): Promise<void> {
    this.assertOpen();
    if (options.signal?.aborted) throw abortedError();
    checkScript(sql);
    this.enforceAppendOnly = false;
    try {
      this.transaction(() => {
        try {
          this.database.exec(sql);
        } catch (error) {
          throw new DbStatementError({ providerMessage: providerMessage(error) });
        }
      });
    } finally {
      this.enforceAppendOnly = true;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new DbError("db.unavailable", "The local SQLite database is closed");
  }

  private transaction<T>(work: () => T): T {
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      // Another connection held the write lock past the busy timeout.
      throw new DbUnavailableError("timeout", providerMessage(error));
    }
    try {
      this.inUserSql = true;
      const result = work();
      this.inUserSql = false;
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.inUserSql = false;
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.inUserSql = false;
    }
  }

  private executeStatement(statement: Statement, index: number): StatementResult {
    const started = performance.now();
    let prepared: StatementSync;
    try {
      prepared = this.database.prepare(statement.sql);
    } catch (error) {
      throw new DbStatementError({
        providerMessage: providerMessage(error),
        statementIndex: index,
      });
    }
    // prepare() silently compiles only the first statement; the lexical check already rejected
    // multi-statement text, and this compares SQLite's own view as a second line of defense.
    if (hasTrailingStatement(statement.sql, prepared.sourceSQL)) {
      throw new DbInvalidStatementError(
        "db.invalid_statement",
        "A batch entry must contain exactly one statement",
        index,
      );
    }
    // Bind every parameter as TEXT, exactly as D1 receives them over REST.
    const params = statement.params.map((param) => String(param));
    const before = this.readCounter(this.totalChanges);
    try {
      let rows: DbRow[] = [];
      let lastRowId: number;
      if (prepared.columns().length > 0) {
        rows = (prepared.all(...params) as Record<string, unknown>[]).map(toRow);
        lastRowId = this.readCounter(this.lastRowId);
      } else {
        lastRowId = Number(prepared.run(...params).lastInsertRowid);
      }
      // D1 documents `changes` as sqlite3_total_changes(); decisions never read it (§3.2).
      const after = this.readCounter(this.totalChanges);
      return {
        success: true,
        results: rows,
        meta: {
          changes: after - before,
          last_row_id: lastRowId,
          duration: performance.now() - started,
        },
      };
    } catch (error) {
      throw new DbStatementError({
        providerMessage: providerMessage(error),
        statementIndex: index,
      });
    }
  }

  private readCounter(statement: StatementSync): number {
    const row = statement.get() as { n: number | bigint } | undefined;
    return Number(row?.n ?? 0);
  }
}

export function createLocalSqliteClient(options: LocalSqliteClientOptions): LocalSqliteClient {
  return new LocalSqliteClient(options);
}
