import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_API_PORT,
  DevConfigError,
  devPlan,
  effectiveApiVariable,
  parseEnvFile,
  resolveApiPort,
  resolveDurable,
  WEB_PORT,
} from "./lib/dev-plan.mjs";

/** The started commands as `name: tool args` strings, in start order. */
function commands(plan) {
  return plan.processes.map((spec) => {
    const tool = spec.tool === "node" ? "node" : spec.tool.bin;
    return `${spec.name}@${spec.cwd}: ${tool} ${spec.args.join(" ")}`;
  });
}

const tscBuild = "build@.: tsc -b tsconfig.build.json";
const tscWatch = "tsc@.: tsc -b tsconfig.build.json --watch --preserveWatchOutput";
const api =
  "api@apps/api: node --watch --enable-source-maps --env-file-if-exists=.env dist/main.js";
const web = "web@apps/web: next dev --port 3000";
const trigger = "trigger@apps/worker: trigger dev";

function buildOf(plan) {
  return (
    plan.build &&
    `${plan.build.name}@${plan.build.cwd}: ${plan.build.tool.bin} ${plan.build.args.join(" ")}`
  );
}

describe("dev process plan (§2.2 (7), §16.3)", () => {
  it("builds once, then watches, runs the api and next dev, without trigger dev when not durable", () => {
    const plan = devPlan({ target: "all", durable: false });
    assert.equal(buildOf(plan), tscBuild);
    assert.deepEqual(commands(plan), [tscWatch, api, web]);
  });

  it("adds trigger dev in apps/worker only when DURABLE=true", () => {
    const plan = devPlan({ target: "all", durable: true });
    assert.equal(buildOf(plan), tscBuild);
    assert.deepEqual(commands(plan), [tscWatch, api, web, trigger]);
  });

  it("dev:api runs the build, watch and api, plus trigger dev in durable mode, but never next dev", () => {
    const local = devPlan({ target: "api", durable: false });
    assert.equal(buildOf(local), tscBuild);
    assert.deepEqual(commands(local), [tscWatch, api]);
    assert.deepEqual(commands(devPlan({ target: "api", durable: true })), [tscWatch, api, trigger]);
  });

  it("dev:web runs next dev alone, with no build (Turbopack reads package sources)", () => {
    for (const durable of [false, true]) {
      const plan = devPlan({ target: "web", durable });
      assert.equal(plan.build, null);
      assert.deepEqual(commands(plan), [web]);
    }
  });

  it("waits for the api on its PORT and the web app on 3000", () => {
    const plan = devPlan({ target: "all", durable: true, apiPort: 4100 });
    const byName = Object.fromEntries(plan.processes.map((spec) => [spec.name, spec]));
    assert.equal(byName.api.ready.url, "http://localhost:4100/healthz");
    assert.equal(byName.web.ready.url, `http://localhost:${WEB_PORT}/`);
    assert.equal(byName.web.ready.anyStatus, true);
    assert.ok(
      byName.tsc.ready.output.test("12:00:00 AM - Found 0 errors. Watching for file changes."),
    );
    assert.deepEqual(byName.tsc.shutdown, { timeoutMs: 1_500, killIsClean: true });
    assert.equal(byName.api.shutdown, undefined);
    assert.ok(byName.trigger.ready.output.test("Local worker ready on branch: main"));
    assert.ok(
      byName.api.failedStartup.test(
        "Failed running 'dist/main.js'. Waiting for file changes before restarting...",
      ),
    );
    assert.equal(
      devPlan({ target: "api", durable: false }).processes[1].ready.url,
      `http://localhost:${DEFAULT_API_PORT}/healthz`,
    );
  });

  it("refuses unknown targets", () => {
    assert.throws(() => devPlan({ target: "worker", durable: false }), DevConfigError);
  });
});

describe("the api environment the plan reads", () => {
  const envFile = parseEnvFile("# comment\nDURABLE=true\nPORT=4200\nTRIGGER_SECRET_KEY=tr_dev_x\n");

  it("reads apps/api/.env with Node's --env-file parser", () => {
    assert.deepEqual(parseEnvFile('A=1\nB="two words"\nexport C=3\n'), {
      A: "1",
      B: "two words",
      C: "3",
    });
    assert.deepEqual(parseEnvFile(undefined), {});
  });

  it("lets the environment win over apps/api/.env, as node --env-file does", () => {
    assert.equal(resolveDurable({ env: {}, envFile }), true);
    assert.equal(resolveDurable({ env: { DURABLE: "false" }, envFile }), false);
    assert.equal(resolveDurable({ env: { DURABLE: "true" }, envFile: {} }), true);
    assert.equal(resolveApiPort({ env: {}, envFile }), 4200);
    assert.equal(resolveApiPort({ env: { PORT: "4300" }, envFile }), 4300);
  });

  it("treats empty values as unset, and an empty environment value still shadows the file", () => {
    assert.equal(resolveDurable({ env: { DURABLE: "" }, envFile }), false);
    assert.equal(resolveDurable({ env: {}, envFile: { DURABLE: "" } }), false);
    assert.equal(resolveApiPort({ env: { PORT: "" }, envFile }), DEFAULT_API_PORT);
    assert.deepEqual(effectiveApiVariable("DURABLE", { env: {}, envFile }), {
      value: "true",
      source: "apps/api/.env",
    });
  });

  it("defaults to local mode on port 4000, and never infers durable mode from a Trigger key", () => {
    assert.equal(resolveDurable({ env: {}, envFile: {} }), false);
    assert.equal(
      resolveDurable({
        env: { TRIGGER_SECRET_KEY: "tr_dev_x", TRIGGER_PROJECT_REF: "proj_abcdefgh" },
        envFile: { TRIGGER_SECRET_KEY: "tr_dev_x" },
      }),
      false,
    );
    assert.equal(resolveApiPort({ env: {}, envFile: {} }), DEFAULT_API_PORT);
  });

  it("refuses values the api's configuration would refuse, naming where they came from", () => {
    assert.throws(
      () => resolveDurable({ env: { DURABLE: "yes" }, envFile }),
      (error) => error instanceof DevConfigError && error.message.includes("environment"),
    );
    assert.throws(
      () => resolveDurable({ env: {}, envFile: { DURABLE: "TRUE" } }),
      (error) => error instanceof DevConfigError && error.message.includes("apps/api/.env"),
    );
    for (const port of ["0", "65536", "04000", "4000.5", "port"]) {
      assert.throws(() => resolveApiPort({ env: { PORT: port }, envFile: {} }), DevConfigError);
    }
  });
});
