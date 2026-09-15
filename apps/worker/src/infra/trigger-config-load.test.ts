import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const workerDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface C12 {
  loadConfig(options: { name: string; cwd: string }): Promise<{
    config: Record<string, unknown>;
    configFile?: string;
  }>;
}

/**
 * Loads `c12` from the installed Trigger CLI package, so the test uses the same loader (and the jiti
 * version it depends on) as `trigger dev` and `trigger deploy`.
 */
async function triggerCliConfigLoader(): Promise<C12> {
  const cliManifest = createRequire(import.meta.url).resolve("trigger.dev/package.json");
  const c12Entry = createRequire(cliManifest).resolve("c12");
  return (await import(pathToFileURL(c12Entry).href)) as C12;
}

describe("trigger.config.ts under the Trigger CLI loader (§8.8)", () => {
  // Vitest imports the config as native ESM, but the CLI evaluates it with jiti 1 and
  // `interopDefault: true`, which hands `import { z } from "zod"` the module's default export. A
  // config that only loads under Vitest would pass every other test while `trigger dev` fails.
  it("loads with c12 exactly as trigger dev loads it", async () => {
    const c12 = await triggerCliConfigLoader();
    const result = await c12.loadConfig({ name: "trigger", cwd: workerDir });
    expect(result.configFile).toBe(join(workerDir, "trigger.config.ts"));
    expect(result.config).toMatchObject({
      project: "proj_rryekrktnjnrdzvabzqd",
      runtime: "node-24",
      dirs: ["./src/trigger"],
      machine: "micro",
      maxDuration: 900,
      retries: { enabledInDev: false, default: { maxAttempts: 1 } },
      build: { conditions: ["source"] },
    });
    const extensions = (result.config.build as { extensions: { name: string }[] }).extensions;
    expect(extensions.map((extension) => extension.name)).toEqual([
      "aptGet",
      "SyncEnvVarsExtension",
      "symplist-image-env",
    ]);
  }, 60_000);
});
