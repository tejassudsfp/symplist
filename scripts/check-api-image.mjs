// Builds apps/api/Dockerfile and smoke-tests a container (architecture §2.2 (2), §17 "api image
// contents"): the image runs `tini -- node dist/main.js` as a non-root user with Git installed and
// no workspace declaration outputs, honors PORT, applies migrations and answers GET /healthz with a
// throwaway local-driver environment, and stops gracefully on `docker stop` (SIGTERM).
//
// Usage: node scripts/check-api-image.mjs [--image <tag>] [--skip-build]
//   --image       the tag to build and test (default symplist-api:check)
//   --skip-build  test an image that is already built
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { freePort, localApiEnv } from "./lib/local-api-env.mjs";
import { repoRoot } from "./lib/processes.mjs";

const { values } = parseArgs({
  options: {
    image: { type: "string", default: "symplist-api:check" },
    "skip-build": { type: "boolean", default: false },
  },
});

/** The port the container listens on, deliberately not the image default, to prove PORT is honored. */
const CONTAINER_PORT = 10_000;
const DATA_DIR = "/app/.local-data";

const failures = [];
const fail = (message) => failures.push(message);
const log = (message) => process.stdout.write(`check-api-image: ${message}\n`);

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw new Error(`docker is not available: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(result.stderr);
    throw new Error(`docker ${args[0]} failed with exit code ${result.status}`);
  }
  return result;
}

function build() {
  log(`building ${values.image}`);
  const child = spawn(
    "docker",
    ["build", "--file", "apps/api/Dockerfile", "--tag", values.image, "."],
    { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
  );
  return new Promise((settle, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? settle() : reject(new Error(`docker build failed with exit code ${code}`)),
    );
  });
}

function inspectImage() {
  const config = JSON.parse(docker(["image", "inspect", values.image]).stdout)[0].Config;
  if (JSON.stringify(config.Cmd) !== JSON.stringify(["tini", "--", "node", "dist/main.js"])) {
    fail(`CMD is ${JSON.stringify(config.Cmd)}`);
  }
  if (config.Entrypoint?.length) {
    fail(`an ENTRYPOINT is set: ${JSON.stringify(config.Entrypoint)}`);
  }
  if (!Object.hasOwn(config.ExposedPorts ?? {}, "4000/tcp")) fail("port 4000 is not exposed");
  if (config.WorkingDir !== "/app") fail(`the working directory is ${config.WorkingDir}`);
  if (!config.Env.includes("NODE_ENV=production")) fail("NODE_ENV=production is not set");

  const probe = docker([
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    values.image,
    "-c",
    [
      'echo "uid=$(id -u)"',
      'echo "gid=$(id -g)"',
      'echo "git=$(git --version)"',
      'echo "tini=$(command -v tini)"',
      'echo "main=$(test -f /app/dist/main.js && echo yes)"',
      'echo "writable=$(touch /app/probe 2>/dev/null && echo yes || echo no)"',
      'echo "migrations=$(ls /app/node_modules/@symplist/db/migrations/*.sql | wc -l)"',
      'echo "declarations=$(find /app/dist /app/node_modules/.pnpm/@symplist+*/node_modules/@symplist/*/dist \\( -name "*.d.ts" -o -name "*.d.ts.map" -o -name "*.tsbuildinfo" \\) | wc -l)"',
    ].join("; "),
  ]).stdout;
  const facts = Object.fromEntries(
    probe
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  );
  if (facts.uid === "0" || facts.uid === undefined) fail(`the image runs as uid ${facts.uid}`);
  if (!/^git version /.test(facts.git ?? "")) fail("git is not installed");
  if (!facts.tini) fail("tini is not installed");
  if (facts.main !== "yes") fail("dist/main.js is missing");
  if (facts.writable !== "no") fail("the service user can write to /app");
  if (!(Number(facts.migrations) > 0)) fail("no @symplist/db migrations in the image");
  if (facts.declarations !== "0") {
    fail(`${facts.declarations} workspace declaration output(s) in the image`);
  }
  return { migrations: Number(facts.migrations), uid: facts.uid, gid: facts.gid };
}

async function smokeContainer({ migrations: migrationCount, uid, gid }) {
  const hostPort = await freePort();
  const env = localApiEnv({
    apiPort: CONTAINER_PORT,
    webPort: 3000,
    localDataDir: DATA_DIR,
  });
  delete env.PATH;
  const envArgs = Object.keys(env).flatMap((name) => ["--env", name]);
  const run = spawnSync(
    "docker",
    [
      "run",
      "--detach",
      ...envArgs,
      // LOCAL_DATA_DIR lies under /app, which the service user cannot write.
      "--tmpfs",
      `${DATA_DIR}:uid=${uid},gid=${gid},mode=0700`,
      "--publish",
      `127.0.0.1:${hostPort}:${CONTAINER_PORT}`,
      values.image,
    ],
    // Secrets reach docker through its environment (`--env NAME`), never through arguments.
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
  );
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    throw new Error("docker run failed");
  }
  const id = run.stdout.trim();
  try {
    let health;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://localhost:${hostPort}/healthz`);
        health = { status: response.status, body: await response.json() };
        if (response.status === 200) break;
      } catch {
        // Not listening yet.
      }
      const state = docker(["inspect", "--format", "{{.State.Running}}", id]).stdout.trim();
      if (state !== "true") break;
      await new Promise((settle) => setTimeout(settle, 500));
    }
    if (health?.status !== 200 || health.body?.status !== "ok") {
      fail(`GET /healthz on PORT=${CONTAINER_PORT} answered ${JSON.stringify(health)}`);
    }
    const processes = docker(["top", id, "-o", "pid,args"]).stdout;
    if (!/tini -- node dist\/main\.js/.test(processes)) fail("tini is not the container's init");
    const logs = docker(["logs", id], { allowFailure: true });
    const applied = (logs.stdout.match(/"event":"migration\.applied"/g) ?? []).length;
    if (applied !== migrationCount) {
      fail(`${applied} migration(s) applied on startup, expected ${migrationCount}`);
    }

    const started = Date.now();
    docker(["stop", "--time", "30", id]);
    const seconds = (Date.now() - started) / 1000;
    const exitCode = docker(["inspect", "--format", "{{.State.ExitCode}}", id]).stdout.trim();
    // Nest's shutdown hooks re-raise SIGTERM after closing, which tini reports as 143.
    if (!["0", "143"].includes(exitCode) || seconds >= 30) {
      fail(`docker stop ended with exit code ${exitCode} after ${seconds.toFixed(1)} s`);
    }
    if (failures.length > 0) process.stderr.write(logs.stdout + logs.stderr);
  } finally {
    docker(["rm", "--force", id], { allowFailure: true });
  }
}

async function main() {
  docker(["version", "--format", "{{.Server.Version}}"]);
  if (!values["skip-build"]) await build();
  await smokeContainer(inspectImage());
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`check-api-image: ${failure}\n`);
    return 1;
  }
  log(`${values.image} runs as a non-root user under tini, answers /healthz and stops gracefully`);
  return 0;
}

process.exitCode = await main();
