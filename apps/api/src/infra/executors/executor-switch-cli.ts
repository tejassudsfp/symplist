import { ConfigError } from "@symplist/config";
import { type ApiConfig, loadApiConfig } from "@symplist/config/api";
import { collectExecutionKinds, type ExecutorMode } from "@symplist/core/events";
import {
  createD1RestClient,
  createLocalSqliteClient,
  type DbClient,
  DEFAULT_LOCAL_DATABASE_PATH,
} from "@symplist/db";
import type { OperationalLog } from "../scheduler/runtime.ts";
import { ExecutionRegistry } from "./execution-registry.ts";
import { ExecutorError, type TriggerRunsClient } from "./executor.ts";
import { ExecutorSwitch, type ExecutorSwitchReport } from "./executor-switch.ts";

export interface ExecutorSwitchCliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now?: () => number;
  /** Builds the Trigger client from `TRIGGER_SECRET_KEY`; the entry point passes the SDK client. */
  readonly createTrigger?: (secretKey: string) => TriggerRunsClient;
  /** Test seam; production builds the D1 or local client from the config. */
  readonly createDb?: (config: ApiConfig) => DbClient;
  readonly registry?: (db: DbClient) => ExecutionRegistry;
}

export const EXECUTOR_SWITCH_USAGE =
  "Usage: pnpm --filter @symplist/api executor:switch --to local|durable";

/** Parses `--to local|durable` (or `--to=…`); returns null for anything else. */
export function parseExecutorSwitchArgs(argv: readonly string[]): ExecutorMode | null {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let target: string | undefined;
  if (args.length === 1 && args[0]?.startsWith("--to=")) target = args[0].slice("--to=".length);
  else if (args.length === 2 && args[0] === "--to") target = args[1];
  return target === "local" || target === "durable" ? target : null;
}

function defaultDb(config: ApiConfig): DbClient {
  if (config.DATA_DRIVER === "local") {
    return createLocalSqliteClient({ path: DEFAULT_LOCAL_DATABASE_PATH });
  }
  const { CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_D1_API_TOKEN } = config;
  if (!CLOUDFLARE_ACCOUNT_ID || !D1_DATABASE_ID || !CLOUDFLARE_D1_API_TOKEN) {
    throw new ExecutorError("executor.not_configured", "DATA_DRIVER=d1 needs the D1 settings");
  }
  return createD1RestClient({
    accountId: CLOUDFLARE_ACCOUNT_ID,
    databaseId: D1_DATABASE_ID,
    apiToken: CLOUDFLARE_D1_API_TOKEN,
    lane: "api",
    runtime: "api",
  });
}

function consoleLog(io: ExecutorSwitchCliIo): OperationalLog {
  const write = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) =>
    (level === "info" ? io.stdout : io.stderr)(JSON.stringify({ level, event, ...(fields ?? {}) }));
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

function describe(report: ExecutorSwitchReport): string[] {
  return [
    report.advanced
      ? `Executor mode ${report.from ?? "unrecorded"} -> ${report.to}; generation ${report.generation}.`
      : `Executor mode is already ${report.to} (generation ${report.generation}); completed the switch steps.`,
    `Interrupted runs: ${report.interrupted}. Cancelled Trigger runs: ${report.cancelledTriggerRuns} (failures: ${report.cancelFailures}). Rebound pending intents: ${report.rebound}.`,
    `Restart the api with DURABLE=${report.to === "durable" ? "true" : "false"} so it dispatches under the new generation.`,
  ];
}

/**
 * The operator command (§8.1). Runs with both configurations available; returns the process exit
 * code. Errors are printed by name and stable code only.
 */
export async function runExecutorSwitchCli(
  argv: readonly string[],
  io: ExecutorSwitchCliIo,
): Promise<number> {
  const target = parseExecutorSwitchArgs(argv);
  if (!target) {
    io.stderr(EXECUTOR_SWITCH_USAGE);
    return 2;
  }
  let config: ApiConfig;
  try {
    config = loadApiConfig(io.env);
  } catch (error) {
    io.stderr(error instanceof ConfigError ? error.message : "Invalid api configuration");
    return 2;
  }
  try {
    const db = (io.createDb ?? defaultDb)(config);
    const secretKey = config.TRIGGER_SECRET_KEY;
    const trigger = secretKey && io.createTrigger ? io.createTrigger(secretKey) : null;
    const registry = io.registry?.(db) ?? new ExecutionRegistry(collectExecutionKinds(), db);
    const report = await new ExecutorSwitch({
      db,
      registry,
      trigger,
      now: io.now ?? Date.now,
      log: consoleLog(io),
    }).switchTo(target);
    for (const line of describe(report)) io.stdout(line);
    return report.cancelFailures > 0 ? 1 : 0;
  } catch (error) {
    const code =
      error instanceof ExecutorError || (error instanceof Error && "code" in error)
        ? String((error as { code: unknown }).code)
        : "internal";
    io.stderr(`executor:switch failed (${error instanceof Error ? error.name : "Error"}: ${code})`);
    if (error instanceof ExecutorError) io.stderr(error.message);
    return 1;
  }
}
