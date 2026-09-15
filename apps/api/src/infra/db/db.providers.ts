import type { Provider } from "@nestjs/common";
import { localDataPaths } from "@symplist/config";
import {
  applyMigrations,
  createD1RestClient,
  createLocalSqliteClient,
  D1Counters,
  type DbClient,
  type MigrationLogEvent,
  type MigrationTarget,
} from "@symplist/db";
import { AppLogger } from "../../common/logging/logger.ts";
import { API_CONFIG, type ApiConfig, runsMigrationsOnStartup } from "../config/api-config.ts";

/** Injection token for the api's {@link DbClient} (D1 REST on the api lane, or local SQLite). */
export const DB_CLIENT = "symplist:DB_CLIENT";

/**
 * Injection token for the absolute directory holding local development data (`DATA_DRIVER=local`):
 * `LOCAL_DATA_DIR`, shared with `trigger dev`, unless a test supplies its own directory.
 */
export const LOCAL_DATA_DIR = "symplist:LOCAL_DATA_DIR";

/** Injection token for the api's D1 request counters (§3.1). */
export const D1_COUNTERS = "symplist:D1_COUNTERS";

/** The api's database client with the handles its lifecycle needs. */
export interface ApiDatabase {
  readonly client: DbClient & MigrationTarget;
  readonly close: () => void;
}

function migrationLogger(logger: AppLogger) {
  const write =
    (level: "info" | "warn" | "error") =>
    (event: MigrationLogEvent): void => {
      // Migration names are validated file names (NNNN_name.sql), never user data.
      const extra: Record<string, string> = { migration: event.name };
      if (event.event === "migration.out_of_order") extra.latestApplied = event.latestApplied;
      if (event.event === "migration.failed") extra.errorCode = event.code;
      logger.write(level, event.event, undefined, extra);
    };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

/**
 * Selects the driver (§16.1): the D1 REST client on the process-wide api lane with the api token,
 * or the local `node:sqlite` stand-in under the local data directory. Outside production the
 * migrations run before the api serves requests (§3.4).
 */
export async function createApiDatabase(
  config: ApiConfig,
  localDataDir: string,
  counters: D1Counters,
  logger: AppLogger,
): Promise<ApiDatabase> {
  let client: DbClient & MigrationTarget;
  let close: () => void;
  if (config.DATA_DRIVER === "d1") {
    const { CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_D1_API_TOKEN } = config;
    if (!CLOUDFLARE_ACCOUNT_ID || !D1_DATABASE_ID || !CLOUDFLARE_D1_API_TOKEN) {
      throw new Error("DATA_DRIVER=d1 requires the D1 account, database and api token");
    }
    client = createD1RestClient({
      accountId: CLOUDFLARE_ACCOUNT_ID,
      databaseId: D1_DATABASE_ID,
      apiToken: CLOUDFLARE_D1_API_TOKEN,
      lane: "api",
      runtime: "api",
      counters,
    });
    close = () => undefined;
  } else {
    const local = createLocalSqliteClient({
      path: localDataPaths(localDataDir).database,
      env: { NODE_ENV: config.NODE_ENV },
    });
    client = local;
    close = () => local.close();
  }
  if (runsMigrationsOnStartup(config)) {
    try {
      await applyMigrations(client, { logger: migrationLogger(logger) });
    } catch (error) {
      close();
      throw error;
    }
  }
  return { client, close };
}

export const API_DATABASE = "symplist:API_DATABASE";

export const dbProviders: Provider[] = [
  {
    provide: D1_COUNTERS,
    useFactory: () => new D1Counters({ runtime: "api", lane: "api" }),
  },
  {
    provide: API_DATABASE,
    useFactory: (config: ApiConfig, dir: string, counters: D1Counters, logger: AppLogger) =>
      createApiDatabase(config, dir, counters, logger),
    inject: [API_CONFIG, LOCAL_DATA_DIR, D1_COUNTERS, AppLogger],
  },
  {
    provide: DB_CLIENT,
    useFactory: (database: ApiDatabase) => database.client,
    inject: [API_DATABASE],
  },
];
