import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  API_PACKAGE,
  deployedDistDirs,
  deployedWorkspacePackages,
  productionWorkspaceClosure,
  pruneDeclarationOutputs,
  relativeSpecifierProblems,
  runtimeExportTargets,
  workspacePackages,
} from "./lib/api-deploy.mjs";
import { freePort, localApiEnv } from "./lib/local-api-env.mjs";
import { repoRoot } from "./lib/processes.mjs";

const temporary = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function tree(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "symplist-api-deploy-test-")));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

function manifest(name, dependencies = {}, devDependencies = {}) {
  return { name, dependencies, devDependencies, exports: { ".": { default: "./dist/index.js" } } };
}

describe("workspace dependency closure", () => {
  it("follows production workspace dependencies transitively and ignores dev dependencies", () => {
    const root = tree({
      "apps/api/package.json": manifest(
        "@x/api",
        { "@x/core": "workspace:*", express: "5.0.0" },
        { "@x/testing": "workspace:*" },
      ),
      "packages/core/package.json": manifest("@x/core", { "@x/db": "workspace:*" }),
      "packages/db/package.json": manifest("@x/db", { "@x/core": "workspace:*" }),
      "packages/testing/package.json": manifest("@x/testing", { "@x/db": "workspace:*" }),
    });
    const packages = workspacePackages(root);
    assert.deepEqual([...packages.keys()].sort(), ["@x/api", "@x/core", "@x/db", "@x/testing"]);
    assert.deepEqual([...productionWorkspaceClosure(packages, "@x/api")].sort(), [
      "@x/core",
      "@x/db",
    ]);
    assert.throws(
      () => productionWorkspaceClosure(packages, "@x/missing"),
      /not a workspace package/,
    );
  });

  it("gives the real api every runtime package and never the testing package", () => {
    const closure = productionWorkspaceClosure(workspacePackages(repoRoot), API_PACKAGE);
    for (const name of [
      "@symplist/db",
      "@symplist/config",
      "@symplist/core",
      "@symplist/analytics",
    ]) {
      assert.ok(closure.has(name), name);
    }
    assert.equal(closure.has("@symplist/testing"), false);
    assert.equal(closure.has("@symplist/web"), false);
  });
});

describe("deploy directory inspection", () => {
  function deployFixture() {
    const root = tree({
      "dist/main.js": 'import { run } from "./run.js";\nrun();\n',
      "dist/run.js": "export const run = () => {};\n",
      "dist/run.d.ts": "export declare const run: () => void;\n",
      "dist/tsconfig.tsbuildinfo": "{}",
      "node_modules/.pnpm/@x+db@file+db/node_modules/@x/db/package.json": { name: "@x/db" },
      "node_modules/.pnpm/@x+db@file+db/node_modules/@x/db/dist/index.js": "export {};\n",
      "node_modules/.pnpm/@x+db@file+db/node_modules/@x/db/dist/index.js.map": "{}",
      "node_modules/.pnpm/@x+db@file+db/node_modules/@x/db/dist/index.d.ts": "export {};\n",
      "node_modules/.pnpm/@x+db@file+db/node_modules/@x/db/dist/index.d.ts.map": "{}",
      "node_modules/.pnpm/@x+db@file+db/node_modules/@x/db/migrations/0001_a.sql": "SELECT 1;",
      "node_modules/.pnpm/zod@4/node_modules/zod/index.d.ts": "export {};\n",
    });
    // pnpm links the dependency into its dependents' node_modules and the top level.
    mkdirSync(join(root, "node_modules", "@x"), { recursive: true });
    symlinkSync(
      join(root, "node_modules/.pnpm/@x+db@file+db/node_modules/@x/db"),
      join(root, "node_modules/@x/db"),
    );
    return root;
  }

  it("finds each injected workspace package once, through the store and the top-level links", () => {
    const root = deployFixture();
    const found = deployedWorkspacePackages(root, "@x");
    assert.deepEqual([...found.keys()], ["@x/db"]);
    assert.equal(found.get("@x/db").length, 1);
    assert.deepEqual(
      deployedDistDirs(root, "@x").map((dir) => dir.slice(root.length)),
      ["/dist", "/node_modules/.pnpm/@x+db@file+db/node_modules/@x/db/dist"],
    );
    assert.deepEqual(deployedWorkspacePackages(root).size, 0);
  });

  it("removes declarations and build info from dists only, keeping JavaScript, maps and dependencies", () => {
    const root = deployFixture();
    const packageDir = join(root, "node_modules/.pnpm/@x+db@file+db/node_modules/@x/db");
    const removed = pruneDeclarationOutputs(root, "@x").map((path) => path.slice(root.length));
    assert.deepEqual(removed.sort(), [
      "/dist/run.d.ts",
      "/dist/tsconfig.tsbuildinfo",
      "/node_modules/.pnpm/@x+db@file+db/node_modules/@x/db/dist/index.d.ts",
      "/node_modules/.pnpm/@x+db@file+db/node_modules/@x/db/dist/index.d.ts.map",
    ]);
    assert.ok(existsSync(join(root, "dist/run.js")));
    assert.ok(existsSync(join(packageDir, "dist/index.js.map")));
    assert.ok(existsSync(join(packageDir, "migrations/0001_a.sql")));
    assert.ok(existsSync(join(root, "node_modules/.pnpm/zod@4/node_modules/zod/index.d.ts")));
    assert.deepEqual(pruneDeclarationOutputs(root, "@x"), []);
  });

  it("reads runtime export targets and skips source and type conditions", () => {
    assert.deepEqual(
      runtimeExportTargets({
        exports: {
          ".": { source: "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./server": {
            source: "./src/server.ts",
            types: "./dist/server.d.ts",
            import: "./dist/server.js",
          },
        },
      }),
      ["./dist/index.js", "./dist/server.js"],
    );
    assert.deepEqual(runtimeExportTargets({ exports: "./dist/index.js" }), ["./dist/index.js"]);
  });

  it("flags relative specifiers that are not emitted JavaScript or that name missing files", () => {
    const root = tree({
      "dist/ok.js": [
        'import { a } from "./a.js";',
        'export * from "../dist/b.js";',
        'import "./side-effect.js";',
        'const lazy = () => import("./lazy.js");',
        'import { z } from "zod";',
        'import data from "./data.json" with { type: "json" };',
      ].join("\n"),
      "dist/a.js": "export const a = 1;\n",
      "dist/b.js": "export const b = 1;\n",
      "dist/side-effect.js": "",
      "dist/lazy.js": "",
      "dist/data.json": "{}",
      "dist/bad.js": [
        'import { c } from "./c.ts";',
        'export { d } from "./missing.js";',
        'const e = await import("./folder");',
      ].join("\n"),
    });
    assert.deepEqual(relativeSpecifierProblems(join(root, "dist")).sort(), [
      "bad.js: ./c.ts (not a JavaScript file)",
      "bad.js: ./folder (not a JavaScript file)",
      "bad.js: ./missing.js (missing)",
    ]);
  });
});

describe("throwaway local api environment", () => {
  it("is accepted by the api configuration with local drivers and fresh secrets", async () => {
    const { parseApiConfig } = await import("../packages/config/src/api.ts");
    const env = localApiEnv({ apiPort: 4123, webPort: 3123, localDataDir: "/tmp/data" });
    const result = parseApiConfig(env);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.config.DATA_DRIVER, "local");
    assert.equal(result.config.EMAIL_DRIVER, "log");
    assert.equal(result.config.DURABLE, false);
    assert.equal(result.config.PORT, 4123);
    assert.equal(env.WEB_ORIGIN, "http://localhost:3123");
    assert.equal(env.LOCAL_DATA_DIR, "/tmp/data");
  });

  it("inherits nothing but PATH and never repeats a secret", () => {
    const first = localApiEnv({ apiPort: 1, webPort: 2, localDataDir: "/a" });
    const second = localApiEnv({ apiPort: 1, webPort: 2, localDataDir: "/a" });
    const secretNames = Object.keys(first).filter((name) => /_\d+$/.test(name));
    assert.ok(secretNames.includes("SESSION_DIGEST_SECRET_1"));
    assert.ok(secretNames.includes("CONTENT_KEK_1"));
    const values = secretNames.map((name) => first[name]);
    assert.equal(new Set(values).size, values.length);
    for (const name of secretNames) assert.notEqual(first[name], second[name]);
    for (const name of Object.keys(process.env)) {
      if (name !== "PATH")
        assert.equal(Object.hasOwn(first, name) && first[name] === process.env[name], false, name);
    }
  });

  it("finds a free loopback port", async () => {
    const port = await freePort();
    assert.ok(Number.isInteger(port) && port > 0 && port < 65_536);
  });
});
