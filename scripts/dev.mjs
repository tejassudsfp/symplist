// Local development loop (architecture §2.2 (7), §16.3).
//
// Usage: node scripts/dev.mjs [all|api|web]     (pnpm dev, pnpm dev:api, pnpm dev:web)
//   all  `tsc -b tsconfig.build.json` once, then `tsc -b --watch --preserveWatchOutput`, the api
//        (`node --watch --enable-source-maps --env-file-if-exists=.env dist/main.js` in apps/api, which
//        applies migrations on startup), `next dev` on port 3000, and `trigger dev` in apps/worker
//        only when DURABLE=true for the api.
//   api  the same without `next dev`.
//   web  `next dev` only; the web app reads package sources directly, so nothing is built.
//
// DURABLE, PORT and LOCAL_DATA_DIR are read as the api will see them: the environment first, then
// apps/api/.env. In durable mode trigger dev gets the api's LOCAL_DATA_DIR (default
// <repo>/.local-data), and an apps/worker env file naming a different directory stops the command.
// Output is prefixed per process (colored in a terminal unless NO_COLOR is set). SIGINT and SIGTERM
// stop every process; a second signal kills them. The exit code is non-zero when the build fails or
// a process fails to start or stops on its own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DevConfigError,
  devPlan,
  devTargets,
  parseEnvFile,
  resolveApiPort,
  resolveDurable,
  sharedLocalDataDir,
  triggerDevEnvFiles,
} from "./lib/dev-plan.mjs";
import { runDev } from "./lib/dev-runner.mjs";
import { repoRoot, StartupError } from "./lib/processes.mjs";

function readEnvFile(...segments) {
  try {
    return readFileSync(join(repoRoot, ...segments), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** The apps/worker env files `trigger dev` reads that exist, parsed. */
function readWorkerEnvFiles() {
  return Object.fromEntries(
    triggerDevEnvFiles.flatMap((name) => {
      const text = readEnvFile("apps", "worker", name);
      return text === undefined ? [] : [[name, parseEnvFile(text)]];
    }),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && !devTargets.includes(args[0]))) {
    throw new DevConfigError(`Usage: node scripts/dev.mjs [${devTargets.join("|")}]`);
  }
  const target = args[0] ?? "all";
  const sources = { env: process.env, envFile: parseEnvFile(readEnvFile("apps", "api", ".env")) };
  const needsApi = target !== "web";
  const durable = needsApi && resolveDurable(sources);
  const localDataDir = durable
    ? sharedLocalDataDir(sources, { root: repoRoot, workerEnvFiles: readWorkerEnvFiles() })
    : undefined;
  const plan = devPlan({
    target,
    durable,
    ...(needsApi ? { apiPort: resolveApiPort(sources) } : {}),
    ...(localDataDir === undefined ? {} : { localDataDir }),
  });
  if (needsApi) {
    process.stdout.write(
      durable
        ? `dev: DURABLE=true, so trigger dev runs the worker tasks with LOCAL_DATA_DIR=${localDataDir}\n`
        : "dev: DURABLE is not true, so the api runs executors in process and trigger dev is not started\n",
    );
  }
  return runDev({ root: repoRoot, plan });
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof DevConfigError || error instanceof StartupError) {
    process.stderr.write(`dev: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
