// Local run smoke test of the built application (architecture §16.3). It builds nothing: run
// `pnpm build` first. Then it:
//   1. starts the api from apps/api/dist with a throwaway local-driver environment (DATA_DRIVER=local,
//      EMAIL_DRIVER=log, DURABLE=false, secrets generated in memory, data in a temporary directory)
//      and `next start` for apps/web, each on a free port;
//   2. waits for GET /healthz to answer {"status":"ok"} and for the web home page to answer 200
//      (after its redirects);
//   3. opens WebSocket upgrades to /v1/ws without a session cookie and requires the gate to refuse
//      them before the handshake: 401 with the web origin, 403 with a foreign origin (§5.2, §7);
//   4. stops both with SIGTERM and requires them to exit without being killed.
// Process output is shown only when a check fails.
//
// Usage: node scripts/smoke-local.mjs    (pnpm smoke:local)
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, localApiEnv } from "./lib/local-api-env.mjs";
import {
  commandFor,
  ProcessGroup,
  repoRoot,
  StartupError,
  waitUntilReady,
} from "./lib/processes.mjs";
import { upgradeStatus } from "./lib/websocket-upgrade.mjs";

const STARTUP_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

const log = (message) => process.stdout.write(`smoke-local: ${message}\n`);

async function main() {
  const apiEntry = join(repoRoot, "apps", "api", "dist", "main.js");
  const webBuild = join(repoRoot, "apps", "web", ".next", "BUILD_ID");
  const missing = [apiEntry, webBuild].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    process.stderr.write(
      `smoke-local: missing build output (${missing.join(", ")}); run pnpm build first\n`,
    );
    return 2;
  }

  const workDir = mkdtempSync(join(tmpdir(), "symplist-smoke-"));
  const apiPort = await freePort();
  const webPort = await freePort();
  const apiOrigin = `http://localhost:${apiPort}`;
  const webOrigin = `http://localhost:${webPort}`;
  const lines = [];
  const output = { isTTY: false, write: (text) => lines.push(text) };
  const group = new ProcessGroup({ names: ["api", "web"], output, color: false });
  const failures = [];

  try {
    const api = group.start({
      name: "api",
      file: process.execPath,
      args: ["--enable-source-maps", apiEntry],
      // The api keeps local data under .local-data in its working directory: the temporary directory.
      cwd: workDir,
      env: localApiEnv({ apiPort, webPort, localDataDir: join(workDir, ".local-data") }),
    });
    const web = group.start({
      name: "web",
      ...commandFor(repoRoot, { package: "next", bin: "next", from: "apps/web" }, [
        "start",
        "--port",
        String(webPort),
      ]),
      cwd: join(repoRoot, "apps", "web"),
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" },
    });
    log(`api on ${apiOrigin}, web on ${webOrigin}, data in ${workDir}`);

    try {
      await Promise.all([
        waitUntilReady(api, {
          ready: { url: `${apiOrigin}/healthz` },
          timeoutMs: STARTUP_TIMEOUT_MS,
        }),
        waitUntilReady(web, {
          ready: { url: `${webOrigin}/`, anyStatus: true },
          timeoutMs: STARTUP_TIMEOUT_MS,
        }),
      ]);
    } catch (error) {
      if (!(error instanceof StartupError)) throw error;
      failures.push(error.message);
    }

    if (failures.length === 0) {
      const health = await fetch(`${apiOrigin}/healthz`);
      const body = await health.json().catch(() => undefined);
      if (health.status === 200 && body?.status === "ok") log("api /healthz answered ok");
      else failures.push(`api /healthz answered ${health.status} ${JSON.stringify(body)}`);

      const home = await fetch(`${webOrigin}/`, { redirect: "follow" });
      await home.body?.cancel();
      if (home.status === 200 && new URL(home.url).origin === webOrigin) {
        log(`web home page answered 200 at ${new URL(home.url).pathname}`);
      } else {
        failures.push(`web home page answered ${home.status} at ${home.url}`);
      }

      const wsUrl = `${apiOrigin}/v1/ws`;
      const withoutCookie = await upgradeStatus(wsUrl, { Origin: webOrigin });
      if (withoutCookie === 401) log("WebSocket upgrade without a session cookie refused with 401");
      else
        failures.push(
          `WebSocket upgrade without a session cookie answered ${withoutCookie}, expected 401`,
        );
      const foreignOrigin = await upgradeStatus(wsUrl, { Origin: "https://attacker.example" });
      if (foreignOrigin === 403) log("WebSocket upgrade from a foreign origin refused with 403");
      else
        failures.push(
          `WebSocket upgrade from a foreign origin answered ${foreignOrigin}, expected 403`,
        );
    }
  } finally {
    const clean = await Promise.all(
      group.processes.map(async (entry) => {
        const stopped = await entry.stop("SIGTERM", SHUTDOWN_TIMEOUT_MS);
        const exit = entry.exitResult;
        // Nest re-raises SIGTERM after its shutdown hooks; next start exits with 128 + SIGTERM (143)
        // once it has closed its server.
        const graceful = exit?.code === 0 || exit?.code === 143 || exit?.signal === "SIGTERM";
        return { name: entry.name, ok: stopped && graceful, exit };
      }),
    );
    for (const result of clean) {
      if (!result.ok) {
        failures.push(`${result.name} did not stop cleanly (${JSON.stringify(result.exit)})`);
      }
    }
    if (failures.length === 0) log("api and web stopped cleanly");
    rmSync(workDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(lines.join(""));
    for (const failure of failures) process.stderr.write(`smoke-local: ${failure}\n`);
    return 1;
  }
  log("passed");
  return 0;
}

process.exitCode = await main();
