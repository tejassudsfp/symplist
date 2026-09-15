// Checks the api's production deploy output, the contents of the apps/api/Dockerfile image
// (architecture §2.2 (2), §17 "api image contents"). It expects the api build (`pnpm --filter
// @symplist/api build`, which `pnpm build` includes) and then:
//   1. runs `pnpm --filter @symplist/api --prod deploy <temporary directory>` and the Dockerfile's
//      prune step (scripts/prune-api-deploy.mjs);
//   2. asserts dist/main.js, every migration of @symplist/db, and the runtime export targets of each
//      workspace package the api needs are present, and that no dev-only workspace package and no
//      declaration output was deployed;
//   3. asserts every relative specifier in the deployed JavaScript names an emitted .js file;
//   4. boots `node dist/main.js` from the deploy with a throwaway local-driver environment, requires
//      every migration to apply and GET /healthz to answer {"status":"ok"}, then requires a clean
//      SIGTERM shutdown.
//
// Usage: node scripts/check-api-deploy.mjs [--keep]   (--keep leaves the deploy directory for inspection)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  API_PACKAGE,
  declarationOutput,
  deployedDistDirs,
  deployedWorkspacePackages,
  filesUnder,
  productionWorkspaceClosure,
  pruneDeclarationOutputs,
  relativeSpecifierProblems,
  runtimeExportTargets,
  workspacePackages,
} from "./lib/api-deploy.mjs";
import { freePort, localApiEnv } from "./lib/local-api-env.mjs";
import { ProcessGroup, repoRoot, StartupError, waitUntilReady } from "./lib/processes.mjs";

const { values } = parseArgs({ options: { keep: { type: "boolean", default: false } } });

const failures = [];
const fail = (message) => failures.push(message);
const log = (message) => process.stdout.write(`check-api-deploy: ${message}\n`);

function pnpm(args) {
  const result = spawnSync("pnpm", args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`pnpm ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function checkContents(deployDir) {
  if (!existsSync(join(deployDir, "dist", "main.js"))) fail("dist/main.js is missing");

  const packages = workspacePackages(repoRoot);
  const needed = productionWorkspaceClosure(packages, API_PACKAGE);
  const deployed = deployedWorkspacePackages(deployDir);
  for (const name of needed) {
    const copies = deployed.get(name) ?? [];
    if (copies.length === 0) {
      fail(`${name} is not deployed`);
      continue;
    }
    const manifest = packages.get(name).manifest;
    for (const copy of copies) {
      for (const target of runtimeExportTargets(manifest)) {
        if (!existsSync(join(copy, target))) fail(`${name} export target ${target} is missing`);
      }
      if (existsSync(join(copy, "src"))) fail(`${name} ships its src directory`);
    }
  }
  for (const name of deployed.keys()) {
    if (!needed.has(name))
      fail(`${name} is deployed but is not a production dependency of the api`);
  }

  const sourceMigrations = readdirSync(join(repoRoot, "packages", "db", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (sourceMigrations.length === 0) fail("packages/db/migrations has no .sql files");
  const migrationsDir = join(deployDir, "node_modules", "@symplist", "db", "migrations");
  const deployedMigrations = existsSync(migrationsDir)
    ? readdirSync(migrationsDir)
        .filter((file) => file.endsWith(".sql"))
        .sort()
    : [];
  if (deployedMigrations.join("\n") !== sourceMigrations.join("\n")) {
    fail(
      `node_modules/@symplist/db/migrations has ${deployedMigrations.length} .sql file(s), expected ${sourceMigrations.length}`,
    );
  }

  const distDirs = deployedDistDirs(deployDir);
  for (const dir of distDirs) {
    for (const file of filesUnder(dir)) {
      if (declarationOutput.test(file)) fail(`declaration output left in the deploy: ${file}`);
    }
    for (const problem of relativeSpecifierProblems(dir)) fail(`relative specifier ${problem}`);
  }
  return { migrations: sourceMigrations, packages: needed.size, distDirs: distDirs.length };
}

async function checkBoot(deployDir, migrations) {
  const apiPort = await freePort();
  const webPort = await freePort();
  const localDataDir = join(deployDir, ".local-data");
  const lines = [];
  const output = { isTTY: false, write: (text) => lines.push(text) };
  const group = new ProcessGroup({ names: ["api"], output, color: false });
  const api = group.start({
    name: "api",
    file: process.execPath,
    args: ["dist/main.js"],
    // The api's default local data directory is .local-data under its working directory.
    cwd: deployDir,
    env: localApiEnv({ apiPort, webPort, localDataDir }),
  });
  const applied = new Set();
  api.onLine((line) => {
    try {
      const entry = JSON.parse(line);
      if (entry.event === "migration.applied") applied.add(entry.migration);
    } catch {
      // Not a structured log line.
    }
  });
  try {
    await waitUntilReady(api, {
      ready: { url: `http://localhost:${apiPort}/healthz` },
      timeoutMs: 60_000,
    });
    const response = await fetch(`http://localhost:${apiPort}/healthz`);
    const body = await response.json();
    if (response.status !== 200 || body?.status !== "ok") {
      fail(`GET /healthz answered ${response.status} ${JSON.stringify(body)}`);
    }
    const missing = migrations.filter((name) => !applied.has(name));
    if (missing.length > 0) fail(`migrations not applied on startup: ${missing.join(", ")}`);
  } catch (error) {
    if (!(error instanceof StartupError)) throw error;
    fail(`the deployed api did not boot: ${error.message}`);
  }
  const clean = await api.stop("SIGTERM", 15_000);
  const exit = api.exitResult;
  // Nest's shutdown hooks run on SIGTERM and then re-raise the signal, so a graceful stop ends with
  // exit code 0 or the SIGTERM signal; only a SIGKILL after the grace period counts as unclean.
  if (!clean || !(exit?.code === 0 || exit?.signal === "SIGTERM")) {
    fail(`the deployed api did not shut down cleanly on SIGTERM (${JSON.stringify(exit)})`);
  }
  if (failures.length > 0) process.stderr.write(lines.join(""));
}

async function main() {
  if (!existsSync(join(repoRoot, "apps", "api", "dist", "main.js"))) {
    process.stderr.write(
      "check-api-deploy: apps/api/dist/main.js is missing; run pnpm build (or pnpm --filter @symplist/api build) first\n",
    );
    return 2;
  }
  const deployDir = join(mkdtempSync(join(tmpdir(), "symplist-api-deploy-")), "app");
  try {
    log(`deploying ${API_PACKAGE} to ${deployDir}`);
    pnpm(["--filter", API_PACKAGE, "--prod", "deploy", deployDir]);
    const removed = pruneDeclarationOutputs(deployDir);
    log(`pruned ${removed.length} declaration output(s)`);
    const contents = checkContents(deployDir);
    log(
      `checked ${contents.packages} workspace package(s), ${contents.distDirs} dist director(ies) and ${contents.migrations.length} migration(s)`,
    );
    await checkBoot(deployDir, contents.migrations);
  } finally {
    if (values.keep) log(`kept ${deployDir}`);
    else rmSync(join(deployDir, ".."), { recursive: true, force: true });
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`check-api-deploy: ${failure}\n`);
    return 1;
  }
  log("the deploy output is complete, has no declaration outputs, boots and shuts down cleanly");
  return 0;
}

process.exitCode = await main();
