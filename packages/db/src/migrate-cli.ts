import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { MigrationTarget } from "./client.ts";
import { createD1RestClient, type FetchLike } from "./d1-rest-client.ts";
import { DbError, isDbError } from "./errors.ts";
import { createLocalSqliteClient, DEFAULT_LOCAL_DATABASE_PATH } from "./local-sqlite-client.ts";
import {
  applyMigrations,
  MIGRATIONS_DIR,
  type MigrationLogEvent,
  type MigrationLogger,
  type MigrationReport,
} from "./migrations.ts";
import { createMigrationLane, type RateLane } from "./rate-limit.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type MigrateCliConfig =
  | {
      readonly driver: "d1";
      readonly migrationsDir: string;
      readonly accountId: string;
      readonly databaseId: string;
      readonly apiToken: string;
      /** Which variable supplied the token; the token itself is never logged. */
      readonly tokenVariable: "CLOUDFLARE_D1_MIGRATE_API_TOKEN" | "CLOUDFLARE_D1_API_TOKEN";
    }
  | {
      readonly driver: "local";
      readonly migrationsDir: string;
      readonly databasePath: string;
    };

function configError(message: string): DbError {
  return new DbError("db.config_invalid", message);
}

export const MIGRATE_USAGE = `Usage: pnpm db:migrate [--driver d1|local] [--database <path>] [--dir <migrations dir>]

Applies pending migrations (architecture §3.4). The driver comes from --driver or DATA_DRIVER.
  d1     needs CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and CLOUDFLARE_D1_MIGRATE_API_TOKEN
         (CI) or CLOUDFLARE_D1_API_TOKEN (Render pre-deploy).
  local  applies to the SQLite file at --database (default ${DEFAULT_LOCAL_DATABASE_PATH});
         refused when NODE_ENV=production.`;

/** Resolves the migration CLI configuration from arguments and environment. */
export function readMigrateConfig(
  argv: readonly string[],
  env: Env,
  cwd: string,
): MigrateCliConfig {
  let values: { driver?: string; database?: string; dir?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        driver: { type: "string" },
        database: { type: "string" },
        dir: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    throw configError(error instanceof Error ? error.message : "Invalid arguments");
  }
  const driver = values.driver ?? env.DATA_DRIVER;
  const migrationsDir = values.dir ? resolve(cwd, values.dir) : MIGRATIONS_DIR;

  if (driver === "local") {
    if (env.NODE_ENV === "production") {
      throw configError("DATA_DRIVER=local is refused when NODE_ENV=production");
    }
    return {
      driver,
      migrationsDir,
      databasePath: resolve(cwd, values.database ?? DEFAULT_LOCAL_DATABASE_PATH),
    };
  }
  if (driver === "d1") {
    if (values.database) throw configError("--database applies only to the local driver");
    const missing = ["CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID"].filter((name) => !env[name]);
    const migrateToken = env.CLOUDFLARE_D1_MIGRATE_API_TOKEN;
    const apiToken = env.CLOUDFLARE_D1_API_TOKEN;
    if (!migrateToken && !apiToken) {
      missing.push("CLOUDFLARE_D1_MIGRATE_API_TOKEN or CLOUDFLARE_D1_API_TOKEN");
    }
    if (missing.length > 0) throw configError(`Missing ${missing.join(", ")}`);
    return {
      driver,
      migrationsDir,
      accountId: env.CLOUDFLARE_ACCOUNT_ID as string,
      databaseId: env.D1_DATABASE_ID as string,
      apiToken: (migrateToken ?? apiToken) as string,
      tokenVariable: migrateToken ? "CLOUDFLARE_D1_MIGRATE_API_TOKEN" : "CLOUDFLARE_D1_API_TOKEN",
    };
  }
  throw configError("Set DATA_DRIVER (or --driver) to d1 or local");
}

export interface MigrateCliIo {
  /** One structured JSON line per event. */
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  /** Transport for the D1 driver; tests inject the fake D1 API. */
  readonly fetch?: FetchLike;
  /** Request lane for the D1 driver; defaults to the sequential migrations lane. */
  readonly lane?: RateLane;
}

function jsonLogger(io: MigrateCliIo): MigrationLogger {
  const write = (level: string, sink: (line: string) => void) => (event: MigrationLogEvent) =>
    sink(JSON.stringify({ level, ...event }));
  return {
    info: write("info", io.log),
    warn: write("warn", io.error),
    error: write("error", io.error),
  };
}

/** Runs the migration CLI; resolves to the process exit code. */
export async function runMigrateCli(
  argv: readonly string[],
  env: Env,
  io: MigrateCliIo,
  cwd: string = process.cwd(),
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.log(MIGRATE_USAGE);
    return 0;
  }
  let target: (MigrationTarget & { close?: () => void }) | undefined;
  try {
    const config = readMigrateConfig(argv, env, cwd);
    if (config.driver === "d1") {
      target = createD1RestClient({
        accountId: config.accountId,
        databaseId: config.databaseId,
        apiToken: config.apiToken,
        lane: io.lane ?? createMigrationLane(),
        runtime: "migrations",
        fetch: io.fetch,
      });
      io.log(
        JSON.stringify({
          level: "info",
          event: "migrate.start",
          driver: "d1",
          token: config.tokenVariable,
        }),
      );
    } else {
      target = createLocalSqliteClient({ path: config.databasePath, env });
      io.log(JSON.stringify({ level: "info", event: "migrate.start", driver: "local" }));
    }
    const report: MigrationReport = await applyMigrations(target, {
      dir: config.migrationsDir,
      logger: jsonLogger(io),
    });
    io.log(
      JSON.stringify({
        level: "info",
        event: "migrate.done",
        applied: report.applied.length,
        alreadyApplied: report.alreadyApplied.length,
        outOfOrder: report.outOfOrder.length,
      }),
    );
    return 0;
  } catch (error) {
    // Errors are reported by name and stable code only (§6.3).
    const code = isDbError(error) ? error.code : "unknown";
    const name = error instanceof Error ? error.name : "Error";
    const detail =
      isDbError(error, "db.config_invalid") || isDbError(error, "db.migration_failed")
        ? error.message
        : undefined;
    io.error(JSON.stringify({ level: "error", event: "migrate.failed", name, code, detail }));
    return 1;
  } finally {
    target?.close?.();
  }
}
