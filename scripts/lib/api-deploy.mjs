// Inspection and pruning of the api's `pnpm --filter @symplist/api --prod deploy` output (architecture
// §2.2 (1), (2)), shared by the Dockerfile's prune step and scripts/check-api-deploy.mjs.
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** The api package; its workspace dependencies are deployed with it. */
export const API_PACKAGE = "@symplist/api";

/**
 * Build outputs only a TypeScript consumer reads. The deployed api runs JavaScript only, and the
 * emitted declarations keep `.ts` relative specifiers (decision F1), so they are removed from the
 * deploy output rather than shipped in the image.
 */
export const declarationOutput = /(\.d\.ts|\.d\.ts\.map|\.tsbuildinfo)$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every workspace package of the repository, by name: its directory and manifest. */
export function workspacePackages(root) {
  const packages = new Map();
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const manifestPath = join(root, group, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = readJson(manifestPath);
      packages.set(manifest.name, { dir: join(root, group, entry.name), manifest });
    }
  }
  return packages;
}

/** The workspace packages `name` needs at runtime: its production `workspace:` dependencies, transitively. */
export function productionWorkspaceClosure(packages, name) {
  const closure = new Set();
  const visit = (current) => {
    const entry = packages.get(current);
    if (!entry) throw new Error(`${current} is not a workspace package`);
    for (const [dependency, range] of Object.entries(entry.manifest.dependencies ?? {})) {
      if (!String(range).startsWith("workspace:") || closure.has(dependency)) continue;
      closure.add(dependency);
      visit(dependency);
    }
  };
  visit(name);
  return closure;
}

/**
 * The workspace packages installed in a deploy directory, by name, each with the real directories of
 * its copies (pnpm injects workspace packages into its virtual store under `node_modules/.pnpm`).
 */
export function deployedWorkspacePackages(deployDir, scope = "@symplist") {
  const found = new Map();
  const add = (path) => {
    if (!existsSync(join(path, "package.json"))) return;
    const real = realpathSync(path);
    const { name } = readJson(join(real, "package.json"));
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(real);
  };
  const topLevel = join(deployDir, "node_modules", scope);
  if (existsSync(topLevel)) for (const name of readdirSync(topLevel)) add(join(topLevel, name));
  const store = join(deployDir, "node_modules", ".pnpm");
  if (existsSync(store)) {
    for (const key of readdirSync(store)) {
      const scoped = join(store, key, "node_modules", scope);
      if (!existsSync(scoped)) continue;
      for (const name of readdirSync(scoped)) add(join(scoped, name));
    }
  }
  return new Map([...found].map(([name, dirs]) => [name, [...dirs].sort()]));
}

/** Every file under `dir`, recursively (symbolic links are not followed). */
export function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

/** The directories holding build output in a deploy: the api's dist and each workspace package's dist. */
export function deployedDistDirs(deployDir, scope = "@symplist") {
  const dirs = [join(deployDir, "dist")];
  for (const copies of deployedWorkspacePackages(deployDir, scope).values()) {
    for (const dir of copies) dirs.push(join(dir, "dist"));
  }
  return dirs.filter((dir) => existsSync(dir));
}

/** Removes declaration outputs from every dist in a deploy directory; returns the removed paths. */
export function pruneDeclarationOutputs(deployDir, scope = "@symplist") {
  const removed = [];
  for (const dir of deployedDistDirs(deployDir, scope)) {
    for (const file of filesUnder(dir)) {
      if (!declarationOutput.test(file)) continue;
      rmSync(file);
      removed.push(file);
    }
  }
  return removed;
}

/** The runtime files a manifest's `exports` point to (`default`, `import` and `require` targets). */
export function runtimeExportTargets(manifest) {
  const targets = new Set();
  const collect = (value, condition) => {
    if (typeof value === "string") {
      if (condition === undefined || ["default", "import", "require", "node"].includes(condition)) {
        targets.add(value);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        collect(nested, key.startsWith(".") ? condition : key);
      }
    }
  };
  collect(manifest.exports, undefined);
  return [...targets].sort();
}

const specifierPatterns = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

/**
 * Problems with relative module specifiers in emitted JavaScript under `dir`: a specifier that is not a
 * JavaScript or JSON file (for example a `.ts` path left unrewritten), or one that names a file the
 * deploy does not contain.
 */
export function relativeSpecifierProblems(dir) {
  const problems = [];
  for (const file of filesUnder(dir)) {
    if (!/\.(m|c)?js$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    const seen = new Set();
    for (const pattern of specifierPatterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
        if (seen.has(specifier)) continue;
        seen.add(specifier);
        const where = `${relative(dir, file)}: ${specifier}`;
        if (!/\.(m|c)?js$|\.json$/.test(specifier)) {
          problems.push(`${where} (not a JavaScript file)`);
          continue;
        }
        const target = resolve(dirname(file), specifier);
        if (!existsSync(target) || !statSync(target).isFile()) {
          problems.push(`${where} (missing)`);
        }
      }
    }
  }
  return problems;
}
