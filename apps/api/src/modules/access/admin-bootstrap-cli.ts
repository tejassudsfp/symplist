import { ConfigError, localDataPaths } from "@symplist/config";
import { type ApiConfig, loadApiConfig } from "@symplist/config/api";
import { adminReasonSchema, idSchema } from "@symplist/contracts";
import { type AdminBootstrapOutcome, AdminBootstrapService } from "@symplist/core/access";
import type { KeyProvider } from "@symplist/crypto";
import { createD1RestClient, createLocalSqliteClient, type DbClient } from "@symplist/db";
import { createApiKeyProvider } from "../../infra/crypto/crypto.providers.ts";

export const ADMIN_BOOTSTRAP_USAGE = [
  "Usage: pnpm --filter @symplist/api admin:bootstrap",
  "       pnpm --filter @symplist/api admin:bootstrap --force-rebootstrap --actor <user id> --reason <text>",
  "Promotes the verified account using ADMIN_BOOTSTRAP_EMAIL (§5.7).",
].join("\n");

export type AdminBootstrapCliArgs =
  | { readonly force: false }
  | { readonly force: true; readonly actorId: string; readonly reason: string };

/** Parses the arguments; returns null for anything the usage does not describe. */
export function parseAdminBootstrapArgs(argv: readonly string[]): AdminBootstrapCliArgs | null {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  if (args.length === 0) return { force: false };
  if (!args.includes("--force-rebootstrap")) return null;
  let actor: string | undefined;
  let reason: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force-rebootstrap") continue;
    if (arg === "--actor" && actor === undefined) {
      actor = args[index + 1];
      index += 1;
    } else if (arg === "--reason" && reason === undefined) {
      reason = args[index + 1];
      index += 1;
    } else {
      return null;
    }
  }
  const actorId = idSchema.safeParse(actor);
  const parsedReason = adminReasonSchema.safeParse(reason);
  if (!actorId.success || !parsedReason.success) return null;
  return { force: true, actorId: actorId.data, reason: parsedReason.data };
}

export interface AdminBootstrapCliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now?: () => number;
  /** Test seams; production builds the configured D1 or local client and the env key provider. */
  readonly createDb?: (config: ApiConfig) => DbClient;
  readonly createKeys?: (config: ApiConfig) => KeyProvider;
}

function defaultDb(config: ApiConfig): DbClient {
  if (config.DATA_DRIVER === "local") {
    return createLocalSqliteClient({
      path: localDataPaths(config.LOCAL_DATA_DIR).database,
      env: { NODE_ENV: config.NODE_ENV },
    });
  }
  const { CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_D1_API_TOKEN } = config;
  if (!CLOUDFLARE_ACCOUNT_ID || !D1_DATABASE_ID || !CLOUDFLARE_D1_API_TOKEN) {
    throw new Error("DATA_DRIVER=d1 needs the D1 settings");
  }
  return createD1RestClient({
    accountId: CLOUDFLARE_ACCOUNT_ID,
    databaseId: D1_DATABASE_ID,
    apiToken: CLOUDFLARE_D1_API_TOKEN,
    lane: "api",
    runtime: "api",
  });
}

function describe(outcome: AdminBootstrapOutcome, force: boolean): { line: string; code: number } {
  switch (outcome.status) {
    case "promoted":
      return {
        line: `${force ? "Re-bootstrapped" : "Bootstrapped"} the administrator account ${outcome.userId}.`,
        code: 0,
      };
    case "consumed":
      return {
        line: force
          ? "Nothing changed: the account is already an administrator."
          : "Nothing changed: admin bootstrap was already consumed. Use --force-rebootstrap with --actor and --reason to bootstrap again.",
        code: 1,
      };
    case "not_eligible":
      return {
        line: "Nothing changed: no verified, non-suspended, non-relocked account uses ADMIN_BOOTSTRAP_EMAIL yet.",
        code: 1,
      };
  }
}

/**
 * `admin:bootstrap` (§5.7, decision R13): the one-time bootstrap run explicitly, or with
 * `--force-rebootstrap --actor <id> --reason <text>` a recorded re-bootstrap. Returns the exit code:
 * 0 promoted, 1 nothing changed or failure, 2 usage or configuration. Prints ids and counts only.
 */
export async function runAdminBootstrapCli(
  argv: readonly string[],
  io: AdminBootstrapCliIo,
): Promise<number> {
  const args = parseAdminBootstrapArgs(argv);
  if (!args) {
    io.stderr(ADMIN_BOOTSTRAP_USAGE);
    return 2;
  }
  let config: ApiConfig;
  try {
    config = loadApiConfig(io.env);
  } catch (error) {
    io.stderr(error instanceof ConfigError ? error.message : "Invalid api configuration");
    return 2;
  }
  const email = config.ADMIN_BOOTSTRAP_EMAIL;
  if (email === undefined) {
    io.stderr("ADMIN_BOOTSTRAP_EMAIL is not set.");
    return 2;
  }
  try {
    const service = new AdminBootstrapService({
      db: (io.createDb ?? defaultDb)(config),
      keys: (io.createKeys ?? createApiKeyProvider)(config),
      now: io.now ?? Date.now,
    });
    const outcome = args.force
      ? await service.forceRebootstrap({ email, actorId: args.actorId, reason: args.reason })
      : await service.bootstrap(email);
    const { line, code } = describe(outcome, args.force);
    (code === 0 ? io.stdout : io.stderr)(line);
    return code;
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String((error as { code: unknown }).code)
        : "internal";
    io.stderr(`admin:bootstrap failed (${error instanceof Error ? error.name : "Error"}: ${code})`);
    return 1;
  }
}
