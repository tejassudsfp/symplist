import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationTarget } from "./client.ts";
import { DbError, isDbError } from "./errors.ts";
import { sql } from "./query.ts";

/** The packaged migrations directory (`@symplist/db/migrations`), next to both `src` and `dist`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** `NNNN_name.sql`: four digits, then lower-case words (§3.4). */
export const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** Exactly the table `wrangler d1 migrations apply --remote` creates, so wrangler can list ours. */
export const D1_MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

export type MigrationLogEvent =
  | { readonly event: "migration.applied"; readonly name: string }
  | {
      readonly event: "migration.out_of_order";
      readonly name: string;
      readonly latestApplied: string;
    }
  | { readonly event: "migration.applied_concurrently"; readonly name: string }
  | { readonly event: "migration.unknown_applied"; readonly name: string }
  | { readonly event: "migration.failed"; readonly name: string; readonly code: string };

export interface MigrationLogger {
  info(event: MigrationLogEvent): void;
  warn(event: MigrationLogEvent): void;
  error(event: MigrationLogEvent): void;
}

export interface MigrationReport {
  /** Files applied by this run, in order. */
  readonly applied: readonly string[];
  /** Files that were already recorded in `d1_migrations`. */
  readonly alreadyApplied: readonly string[];
  /** Applied files that sorted before the latest previously applied file. */
  readonly outOfOrder: readonly string[];
}

function migrationError(message: string): DbError {
  return new DbError("db.migration_failed", message);
}

/** Reads `NNNN_name.sql` files from a directory in lexical order; any other `.sql` name is an error. */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const invalid = names.filter((name) => !MIGRATION_FILE_PATTERN.test(name));
  if (invalid.length > 0) {
    throw migrationError(`Migration files must be named NNNN_name.sql: ${invalid.join(", ")}`);
  }
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(join(dir, name), "utf8");
      if (text.trim() === "") throw migrationError(`Migration ${name} is empty`);
      return { name, sql: text };
    }),
  );
}

/**
 * The wrangler-compatible request for one migration: the file followed by its `d1_migrations`
 * insert, sent as one request so the file and its record commit together.
 */
export function migrationRequestSql(file: MigrationFile): string {
  if (!MIGRATION_FILE_PATTERN.test(file.name)) {
    throw migrationError(`Invalid migration name ${JSON.stringify(file.name)}`);
  }
  return `${file.sql}\nINSERT INTO "d1_migrations" (name)\nvalues ('${file.name.replaceAll("'", "''")}');`;
}

const silentLogger: MigrationLogger = { info: () => {}, warn: () => {}, error: () => {} };

async function appliedNames(target: MigrationTarget): Promise<string[]> {
  const rows = await target.all<{ name: string | null }>(
    sql(`SELECT name FROM "d1_migrations" ORDER BY id`),
  );
  return rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
}

async function isRecorded(target: MigrationTarget, name: string): Promise<boolean> {
  const row = await target.first(
    sql(`SELECT 1 AS applied FROM "d1_migrations" WHERE name = :name`, { name }),
  );
  return row !== null;
}

/**
 * Applies every unapplied migration in lexical order, one request per file (§3.4). Safe to run
 * repeatedly and concurrently: a file another runner recorded first is skipped. Stops at the first
 * failing file, whose request rolls back as a whole.
 */
export async function applyMigrations(
  target: MigrationTarget,
  options: {
    readonly migrations?: readonly MigrationFile[];
    readonly dir?: string;
    readonly logger?: MigrationLogger;
    readonly signal?: AbortSignal;
  } = {},
): Promise<MigrationReport> {
  const logger = options.logger ?? silentLogger;
  const migrations = options.migrations ?? (await loadMigrations(options.dir));
  const names = migrations.map((file) => file.name);
  if (new Set(names).size !== names.length) throw migrationError("Duplicate migration names");
  const sorted = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  await target.executeScript(D1_MIGRATIONS_TABLE_SQL, { signal: options.signal });
  const recorded = await appliedNames(target);
  const recordedSet = new Set(recorded);
  const known = new Set(names);
  for (const name of recorded) {
    if (!known.has(name)) logger.warn({ event: "migration.unknown_applied", name });
  }
  let latestApplied = recorded.reduce<string | undefined>(
    (latest, name) => (latest === undefined || name > latest ? name : latest),
    undefined,
  );

  const applied: string[] = [];
  const outOfOrder: string[] = [];
  const alreadyApplied = sorted
    .filter((file) => recordedSet.has(file.name))
    .map((file) => file.name);

  for (const file of sorted) {
    if (recordedSet.has(file.name)) continue;
    if (latestApplied !== undefined && file.name < latestApplied) {
      outOfOrder.push(file.name);
      logger.warn({ event: "migration.out_of_order", name: file.name, latestApplied });
    }
    try {
      await target.executeScript(migrationRequestSql(file), { signal: options.signal });
    } catch (error) {
      // Another runner may have recorded the file first (its UNIQUE name insert, or its DDL, then
      // fails here), or a write outcome may be unknown; the record decides.
      if (!isDbError(error, "db.aborted") && (await isRecorded(target, file.name))) {
        if (isDbError(error, "db.unknown_outcome")) {
          // Our own request committed but its response was lost.
          applied.push(file.name);
          logger.info({ event: "migration.applied", name: file.name });
        } else {
          logger.warn({ event: "migration.applied_concurrently", name: file.name });
        }
        if (latestApplied === undefined || file.name > latestApplied) latestApplied = file.name;
        continue;
      }
      const code = isDbError(error) ? error.code : "unknown";
      logger.error({ event: "migration.failed", name: file.name, code });
      throw error;
    }
    applied.push(file.name);
    logger.info({ event: "migration.applied", name: file.name });
    if (latestApplied === undefined || file.name > latestApplied) latestApplied = file.name;
  }
  return { applied, alreadyApplied, outOfOrder };
}
