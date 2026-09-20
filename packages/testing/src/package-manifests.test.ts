import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Package manifests and builds (architecture §2.2, point 1): every workspace package under
 * `packages/` exports each subpath as `{ source, types, default }` (in that order, so the `source`
 * condition wins where it is enabled and `types` precedes `default`), ships only `dist` (and
 * `@symplist/db` its `migrations`), and builds as a composite project with `rootDir: "src"`.
 * `apps/*` are deployables, not imported packages, so the rule does not apply to them.
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const conditionOrder = ["source", "types", "default"];

/** Parses JSON with comments and trailing commas, as TypeScript reads tsconfig files. */
function parseJsonc(text: string): unknown {
  let output = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 1;
    } else {
      output += char;
    }
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/g, "$1"));
}

interface PackageInput {
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
  readonly tsconfig: Record<string, unknown> | null;
  /** Whether a path relative to the package directory exists. */
  readonly exists: (path: string) => boolean;
}

/** Every §2.2 (1) rule a package breaks, as readable messages. */
function manifestViolations(input: PackageInput): string[] {
  const { dir, manifest, tsconfig, exists } = input;
  const problems: string[] = [];
  const name = typeof manifest.name === "string" ? manifest.name : `(${dir})`;

  const exportsField = manifest.exports;
  if (typeof exportsField !== "object" || exportsField === null || Array.isArray(exportsField)) {
    problems.push(`${name}: "exports" must map subpaths to conditions`);
  } else {
    const subpaths = Object.entries(exportsField as Record<string, unknown>);
    if (!subpaths.some(([subpath]) => subpath === ".")) {
      problems.push(`${name}: "exports" has no "." entry`);
    }
    for (const [subpath, target] of subpaths) {
      const where = `${name} exports["${subpath}"]`;
      if (subpath !== "." && !/^\.\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/.test(subpath)) {
        problems.push(`${where}: subpaths are "." or "./<name>"`);
      }
      if (typeof target !== "object" || target === null || Array.isArray(target)) {
        problems.push(`${where}: must be { source, types, default }, not a bare path`);
        continue;
      }
      const conditions = target as Record<string, unknown>;
      if (JSON.stringify(Object.keys(conditions)) !== JSON.stringify(conditionOrder)) {
        problems.push(`${where}: conditions must be exactly source, types, default in that order`);
        continue;
      }
      const { source, types, default: runtime } = conditions;
      const match = typeof source === "string" ? /^\.\/src\/(.+)\.tsx?$/.exec(source) : null;
      if (!match) {
        problems.push(`${where}: source must be a ./src/*.ts file`);
        continue;
      }
      const stem = match[1] as string;
      if (types !== `./dist/${stem}.d.ts`) {
        problems.push(`${where}: types must be ./dist/${stem}.d.ts`);
      }
      if (runtime !== `./dist/${stem}.js`) {
        problems.push(`${where}: default must be ./dist/${stem}.js`);
      }
      if (!exists(source as string)) problems.push(`${where}: ${source} does not exist`);
    }
  }

  const files = manifest.files;
  const expectedFiles = name === "@symplist/db" ? ["dist", "migrations"] : ["dist"];
  if (
    !Array.isArray(files) ||
    JSON.stringify([...files].sort()) !== JSON.stringify([...expectedFiles].sort())
  ) {
    problems.push(`${name}: "files" must be ${JSON.stringify(expectedFiles)}`);
  }
  if (name === "@symplist/db" && !exists("migrations")) {
    problems.push(`${name}: the migrations directory is missing`);
  }

  const options = (tsconfig?.compilerOptions ?? null) as Record<string, unknown> | null;
  if (!options) {
    problems.push(`${name}: tsconfig.json with compilerOptions is missing`);
  } else {
    if (options.composite !== true) problems.push(`${name}: tsconfig.json must set composite`);
    if (options.rootDir !== "src") problems.push(`${name}: tsconfig.json must set rootDir "src"`);
    if (options.outDir !== "dist") problems.push(`${name}: tsconfig.json must set outDir "dist"`);
  }
  return problems;
}

function workspacePackages(): PackageInput[] {
  const packagesDir = join(repoRoot, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")),
    )
    .map((entry) => {
      const dir = join(packagesDir, entry.name);
      const tsconfigPath = join(dir, "tsconfig.json");
      return {
        dir: `packages/${entry.name}`,
        manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
          string,
          unknown
        >,
        tsconfig: existsSync(tsconfigPath)
          ? (parseJsonc(readFileSync(tsconfigPath, "utf8")) as Record<string, unknown>)
          : null,
        exists: (path: string) => existsSync(join(dir, path)),
      };
    });
}

describe("package manifests (§2.2)", () => {
  it("covers every workspace package under packages/", () => {
    const names = workspacePackages().map((pkg) => pkg.manifest.name);
    expect(names).toContain("@symplist/db");
    expect(names).toContain("@symplist/testing");
    // Every directory is a package; stray files such as Finder's .DS_Store are not.
    const directories = readdirSync(join(repoRoot, "packages"), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory(),
    );
    expect(names).toHaveLength(directories.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("exports source, types and default for every subpath, ships dist and builds composite from src", () => {
    const violations = workspacePackages().flatMap((pkg) => manifestViolations(pkg));
    expect(violations).toEqual([]);
  });

  it("detects each broken rule in fixtures", () => {
    // Built paths are assembled so the relative-specifier scan never mistakes them for imports.
    const built = (dir: string, stem: string, extension: string) => `./${dir}/${stem}.${extension}`;
    const good = {
      dir: "packages/probe",
      manifest: {
        name: "@symplist/probe",
        exports: {
          ".": {
            source: "./src/index.ts",
            types: "./dist/index.d.ts",
            default: built("dist", "index", "js"),
          },
        },
        files: ["dist"],
      },
      tsconfig: { compilerOptions: { composite: true, rootDir: "src", outDir: "dist" } },
      exists: () => true,
    };
    expect(manifestViolations(good)).toEqual([]);
    const broken = (patch: Partial<PackageInput>) => manifestViolations({ ...good, ...patch });

    expect(
      broken({
        manifest: {
          ...good.manifest,
          exports: {
            ".": built("dist", "index", "js"),
            "./server": { types: "./dist/server.d.ts", default: built("dist", "server", "js") },
            "./web": {
              default: built("dist", "web", "js"),
              types: "./dist/web.d.ts",
              source: "./src/web.ts",
            },
            "./api": {
              source: "./src/api.ts",
              types: "./dist/other.d.ts",
              default: built("lib", "api", "js"),
            },
          },
        },
      }),
    ).toEqual([
      '@symplist/probe exports["."]: must be { source, types, default }, not a bare path',
      '@symplist/probe exports["./server"]: conditions must be exactly source, types, default in that order',
      '@symplist/probe exports["./web"]: conditions must be exactly source, types, default in that order',
      '@symplist/probe exports["./api"]: types must be ./dist/api.d.ts',
      '@symplist/probe exports["./api"]: default must be ./dist/api.js',
    ]);
    expect(broken({ manifest: { ...good.manifest, files: ["dist", "src"] } })).toEqual([
      '@symplist/probe: "files" must be ["dist"]',
    ]);
    expect(
      broken({
        manifest: { ...good.manifest, name: "@symplist/db" },
        exists: (path) => path !== "migrations",
      }),
    ).toEqual([
      '@symplist/db: "files" must be ["dist","migrations"]',
      "@symplist/db: the migrations directory is missing",
    ]);
    expect(broken({ tsconfig: { compilerOptions: { rootDir: ".", outDir: "dist" } } })).toEqual([
      "@symplist/probe: tsconfig.json must set composite",
      '@symplist/probe: tsconfig.json must set rootDir "src"',
    ]);
    expect(broken({ exists: (path) => path !== "./src/index.ts" })).toEqual([
      '@symplist/probe exports["."]: ./src/index.ts does not exist',
    ]);
    expect(parseJsonc('{ // note\n "a": "x // y", /* b */ "c": [1,], }')).toEqual({
      a: "x // y",
      c: [1],
    });
  });
});
