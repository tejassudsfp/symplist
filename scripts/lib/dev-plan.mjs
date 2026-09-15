// The process plan behind `pnpm dev`, `pnpm dev:api` and `pnpm dev:web` (architecture §2.2 (7),
// §16.3). Pure: it decides which commands run from the target and the api's effective environment,
// and never spawns anything, so the rules are unit-tested in dev-plan.test.mjs.
import { parseEnv } from "node:util";

/** What each command starts: everything, the api side only, or the web app only. */
export const devTargets = Object.freeze(["all", "api", "web"]);

/** Local ports (§16.3). The api honors its own PORT; the web app always runs on 3000. */
export const DEFAULT_API_PORT = 4000;
export const WEB_PORT = 3000;

/** A startup problem the developer must fix; reported without a stack trace. */
export class DevConfigError extends Error {
  name = "DevConfigError";
}

/**
 * Parses the api's `.env` file with Node's own parser, the one `node --env-file-if-exists=.env` uses,
 * so values resolve exactly as the api process will see them.
 */
export function parseEnvFile(text) {
  return text === undefined ? {} : parseEnv(text);
}

/**
 * The value the api process will see for a variable: `node --env-file` never overrides a variable
 * that is already set in the environment (even to an empty string), so the environment wins over
 * `apps/api/.env`. Empty values count as unset, as in `@symplist/config` (decision C1.5).
 */
export function effectiveApiVariable(name, { env, envFile }) {
  if (Object.hasOwn(env, name)) {
    const value = env[name];
    return value === undefined || value === "" ? undefined : { value, source: "environment" };
  }
  if (Object.hasOwn(envFile, name) && envFile[name] !== "") {
    return { value: envFile[name], source: "apps/api/.env" };
  }
  return undefined;
}

/**
 * Whether the api runs in durable mode, which is the only reason to start `trigger dev` (§16.3):
 * never inferred from `TRIGGER_SECRET_KEY` or any other variable. Values other than `true` and
 * `false` are refused, as the api's configuration would refuse them.
 */
export function resolveDurable(sources) {
  const resolved = effectiveApiVariable("DURABLE", sources);
  if (resolved === undefined) return false;
  if (resolved.value === "true") return true;
  if (resolved.value === "false") return false;
  throw new DevConfigError(`DURABLE from ${resolved.source} must be "true" or "false"`);
}

/** The port the api listens on: its PORT (1 to 65535, canonical decimal) or 4000. */
export function resolveApiPort(sources) {
  const resolved = effectiveApiVariable("PORT", sources);
  if (resolved === undefined) return DEFAULT_API_PORT;
  const port = /^[1-9][0-9]{0,4}$/.test(resolved.value) ? Number(resolved.value) : Number.NaN;
  if (!(port >= 1 && port <= 65_535)) {
    throw new DevConfigError(`PORT from ${resolved.source} must be an integer from 1 to 65535`);
  }
  return port;
}

/**
 * The plan for a target. `build` runs once and must succeed before anything else starts; each
 * `processes` entry is a long-running command with:
 * - `tool`: `node` (the current Node binary) or `{ package, bin, from }`, a package binary resolved
 *   from the `from` directory and run with the current Node binary;
 * - `cwd` relative to the repository root;
 * - `ready`: how startup completes (an output line pattern, or an HTTP URL answering 2xx);
 * - `failedStartup`: output that means the command failed while starting even though it keeps
 *   running (node --watch waits for file changes after the api exits);
 * - `shutdown`: an optional shorter grace period, and whether a SIGKILL after it is expected.
 */
export function devPlan({ target, durable, apiPort = DEFAULT_API_PORT }) {
  if (!devTargets.includes(target)) {
    throw new DevConfigError(`Unknown dev target "${target}"; use one of ${devTargets.join(", ")}`);
  }
  const typescript = { package: "typescript", bin: "tsc", from: "." };
  const processes = [];
  let build = null;

  if (target === "all" || target === "api") {
    build = {
      name: "build",
      tool: typescript,
      args: ["-b", "tsconfig.build.json"],
      cwd: ".",
    };
    processes.push({
      name: "tsc",
      tool: typescript,
      args: ["-b", "tsconfig.build.json", "--watch", "--preserveWatchOutput"],
      cwd: ".",
      ready: { output: /Watching for file changes/ },
      // TypeScript 7.0.2's watch mode takes 6 to 9 seconds to act on SIGINT or SIGTERM. It only
      // writes build output, which the initial `tsc -b` of the next run brings up to date, so it is
      // killed after a short grace period instead of holding up every shutdown.
      shutdown: { timeoutMs: 1_500, killIsClean: true },
    });
    processes.push({
      name: "api",
      tool: "node",
      args: ["--watch", "--enable-source-maps", "--env-file-if-exists=.env", "dist/main.js"],
      cwd: "apps/api",
      ready: { url: `http://localhost:${apiPort}/healthz` },
      failedStartup: /^Failed running /,
    });
  }
  if (target === "all" || target === "web") {
    processes.push({
      name: "web",
      tool: { package: "next", bin: "next", from: "apps/web" },
      args: ["dev", "--port", String(WEB_PORT)],
      cwd: "apps/web",
      ready: { url: `http://localhost:${WEB_PORT}/`, anyStatus: true },
    });
  }
  if ((target === "all" || target === "api") && durable) {
    processes.push({
      name: "trigger",
      tool: { package: "trigger.dev", bin: "trigger", from: "apps/worker" },
      args: ["dev"],
      cwd: "apps/worker",
      ready: { output: /Local worker ready/ },
    });
  }
  return { build, processes };
}
