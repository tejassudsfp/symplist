import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig, type Plugin } from "vite";
import { defineConfig, type ViteUserConfig } from "vitest/config";

/** The export condition that points workspace packages at their TypeScript sources (§2.2). */
export const sourceCondition = "source";

const packagesDir = fileURLToPath(new URL("../../", import.meta.url));
const workspaceSpecifier = /^@symplist\/([^/]+)(\/.*)?$/;

type ExportTarget = string | { readonly [condition: string]: ExportTarget };

/**
 * The `source` export of a workspace package specifier such as `@symplist/config/web`, or undefined
 * when the specifier is not a workspace package export.
 */
export function resolveWorkspaceSource(specifier: string): string | undefined {
  const match = workspaceSpecifier.exec(specifier);
  if (!match?.[1]) return undefined;
  const packageDir = join(packagesDir, match[1]);
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    exports?: Readonly<Record<string, ExportTarget>>;
  };
  const target = manifest.exports?.[`.${match[2] ?? ""}`];
  const source = typeof target === "object" ? target[sourceCondition] : undefined;
  return typeof source === "string" ? join(packageDir, source) : undefined;
}

/**
 * Resolves `@symplist/*` imports through their `source` export. The condition is applied to workspace
 * packages only: Vitest forwards `resolve.conditions` to Node as `--conditions` flags, and several
 * third-party packages (for example `eventsource`) also publish a `source` condition that points at
 * TypeScript files Node refuses to load from node_modules.
 */
export function workspaceSourcePlugin(): Plugin {
  return {
    name: "symplist:workspace-source",
    enforce: "pre",
    resolveId(specifier) {
      return resolveWorkspaceSource(specifier) ?? null;
    },
  };
}

/**
 * Shared Vitest config (§2.2, §17). Workspace imports resolve to `src`, so tests never need a build.
 * Vite's config loader resolves bare imports without the `source` condition, so vitest.config.ts
 * files import this module by relative path.
 */
export const sharedVitestConfig: ViteUserConfig = defineConfig({
  plugins: [workspaceSourcePlugin()],
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    restoreMocks: true,
  },
});

/** The shared config merged with package-specific options. */
export function defineWorkspaceVitestConfig(overrides: ViteUserConfig = {}): ViteUserConfig {
  return mergeConfig(sharedVitestConfig, overrides);
}
