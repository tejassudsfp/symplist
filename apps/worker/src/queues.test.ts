// Installs the in-memory resource catalog so task declarations register their manifests.
import "@trigger.dev/sdk/ai/test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1_BUDGET, workerProcessRate } from "@symplist/db";
import { resourceCatalog } from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import { workerProcessLane } from "./infra/clients.ts";
import {
  d1,
  d1Git,
  d1QueueFamily,
  d1QueueFamilyConcurrency,
  reminderScan,
  workerD1RatePerProcess,
} from "./queues.ts";

const srcDir = dirname(fileURLToPath(import.meta.url));
const triggerDir = join(srcDir, "trigger");
/** Modules that construct or return the worker D1 client. */
const d1ClientModules = [join(srcDir, "infra", "clients.ts"), join(srcDir, "infra", "runtime.ts")];
const familyExports = new Set(["d1", "d1Git", "reminderScan"]);

type SourceMap = ReadonlyMap<string, string>;

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

function relativeImports(file: string, source: string): string[] {
  return [
    ...source.matchAll(
      /(?:import|export)\s[^"']*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    ),
  ].map((match) => {
    const target = resolve(dirname(file), (match[1] ?? match[2]) as string);
    return target.endsWith(".ts") ? target : `${target}.ts`;
  });
}

/** Whether a module transitively imports a worker D1 client module. */
function reachesD1Client(file: string, sources: SourceMap, seen = new Set<string>()): boolean {
  if (d1ClientModules.includes(file)) return true;
  if (seen.has(file)) return false;
  seen.add(file);
  const source = sources.get(file);
  if (source === undefined) return false;
  return relativeImports(file, source).some((target) => reachesD1Client(target, sources, seen));
}

/**
 * The §3.1 queue-family rule for one task file: a task that reaches the worker D1 client declares
 * `queue: <family export>` imported from `queues.ts`, and no task file ever declares a queue inline.
 */
function queueFamilyViolations(file: string, sources: SourceMap): string[] {
  const source = sources.get(file) ?? "";
  const problems: string[] = [];
  if (/\bqueue\s*\(\s*\{/.test(source) || /\bqueue\s*:\s*\{/.test(source)) {
    problems.push("declares a queue inline");
  }
  if (!reachesD1Client(file, sources)) return problems;
  const imported = [
    ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']*queues(?:\.ts)?)["']/g),
  ]
    .flatMap((match) =>
      (match[1] ?? "").split(",").map(
        (name) =>
          name
            .trim()
            .split(/\s+as\s+/)
            .pop() ?? "",
      ),
    )
    .filter((name) => familyExports.has(name));
  const declared = [...source.matchAll(/\bqueue\s*:\s*([A-Za-z_$][\w$]*)/g)].map(
    (match) => match[1],
  );
  if (declared.length === 0) problems.push("uses D1 without declaring a family queue");
  for (const name of declared) {
    if (!imported.includes(name as string))
      problems.push(`declares queue ${name} not imported from queues.ts`);
  }
  return problems;
}

function workerSources(): Map<string, string> {
  return new Map(listSources(srcDir).map((file) => [file, readFileSync(file, "utf8")]));
}

describe("D1 queue family (§3.1)", () => {
  it("declares the three family queues with their concurrency limits", () => {
    expect(d1).toMatchObject({ name: "d1", concurrencyLimit: 4 });
    expect(d1Git).toMatchObject({ name: "d1-git", concurrencyLimit: 2 });
    expect(reminderScan).toMatchObject({ name: "reminder-scan", concurrencyLimit: 1 });
    expect(d1QueueFamily).toHaveLength(3);
  });

  it("keeps N × the per-process rate within 1 request per second", () => {
    expect(d1QueueFamilyConcurrency).toBe(7);
    expect(d1QueueFamilyConcurrency).toBe(D1_BUDGET.worker.familyConcurrency);
    expect(workerD1RatePerProcess).toBe(workerProcessRate(7));
    expect(d1QueueFamilyConcurrency * workerD1RatePerProcess).toBeLessThanOrEqual(
      D1_BUDGET.worker.totalRequestsPerSecond,
    );
    const lane = workerProcessLane();
    expect(lane.ratePerSecond * d1QueueFamilyConcurrency).toBeLessThanOrEqual(1);
    expect(lane.burst).toBe(4);
  });

  it("requires every task that imports the worker D1 client to declare a family queue", () => {
    const sources = workerSources();
    const taskFiles = listSources(triggerDir);
    expect(taskFiles.length).toBeGreaterThan(0);
    const violations = taskFiles.flatMap((file) =>
      queueFamilyViolations(file, sources).map(
        (problem) => `${relative(srcDir, file)}: ${problem}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("constructs D1 clients only in infra/clients.ts, so no task can bypass the family rule", () => {
    const constructors =
      /\b(?:createD1RestClient|createLocalSqliteClient|createWorkerLane|processLane)\b/;
    const offenders = [...workerSources()]
      .filter(([file, source]) => file !== d1ClientModules[0] && constructors.test(source))
      .map(([file]) => relative(srcDir, file));
    expect(offenders).toEqual([]);
  });

  it("detects violations in the checker's own fixtures", () => {
    const task = join(triggerDir, "fixture", "task.ts");
    const helper = join(triggerDir, "fixture", "helper.ts");
    const fixtures = (taskSource: string) =>
      new Map([
        [task, taskSource],
        [
          helper,
          'import { createWorkerDb } from "../../infra/clients.ts";\nexport const db = createWorkerDb;',
        ],
      ]);
    expect(
      queueFamilyViolations(
        task,
        fixtures('import { db } from "./helper.ts";\ntask({ id: "x", run: async () => db });'),
      ),
    ).toEqual(["uses D1 without declaring a family queue"]);
    expect(
      queueFamilyViolations(
        task,
        fixtures(
          'import { db } from "./helper.ts";\nconst q = queue({ name: "own" });\ntask({ id: "x", queue: q });',
        ),
      ),
    ).toEqual(["declares a queue inline", "declares queue q not imported from queues.ts"]);
    expect(
      queueFamilyViolations(
        task,
        fixtures(
          'import { d1 } from "../../queues.ts";\nimport { db } from "./helper.ts";\ntask({ id: "x", queue: d1 });',
        ),
      ),
    ).toEqual([]);
    expect(
      queueFamilyViolations(task, fixtures('task({ id: "x", queue: { concurrencyLimit: 1 } });')),
    ).toEqual(["declares a queue inline"]);
  });

  it("registers every task with an explicit retry, and D1 tasks on a family queue (§8.8)", async () => {
    const sources = workerSources();
    const files = listSources(triggerDir);
    for (const file of files) await import(file);
    const manifests = resourceCatalog.listTaskManifests();
    expect(manifests.map((manifest) => manifest.id)).toContain("symplist-healthcheck");
    const familyNames = new Set(d1QueueFamily.map((family) => family.name));
    for (const manifest of manifests) {
      const file = files.find((candidate) => sources.get(candidate)?.includes(`"${manifest.id}"`));
      expect(manifest.retry, `${manifest.id} declares retry`).toBeDefined();
      if (file && reachesD1Client(file, sources)) {
        expect(
          familyNames.has(manifest.queue?.name ?? ""),
          `${manifest.id} uses a D1 family queue`,
        ).toBe(true);
      }
    }
  });
});
