// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The packaging decisions that are easy to undo by accident, asserted so they are not. Signing is off on
 * purpose in phase 2, the staged web server has to land outside the asar for Next to resolve its own
 * files, and Windows must stay merely unbuilt rather than impossible.
 */
interface BuilderConfig {
  appId: string;
  productName: string;
  asar: boolean;
  asarUnpack: string[];
  files: string[];
  extraResources: { from: string; to: string }[];
  directories: { output: string; buildResources: string };
  mac: { identity: null; notarize: boolean; target: { target: string; arch: string[] }[] };
  win?: { target: { target: string }[] };
  afterSign?: unknown;
}

const config = parse(
  readFileSync(fileURLToPath(new URL("../../electron-builder.yml", import.meta.url)), "utf8"),
) as BuilderConfig;

/**
 * Where the staging scripts put a tree that carries its own root `node_modules`: `stage-web.mjs` writes
 * `build/web` and `vendor-harness.mjs` writes `build/harness`. Neither may be a mapping's `from` — see
 * the extraResources test for what happens when one is. `locateHarness` resolves
 * `<Resources>/harness/launch-acp.mjs`, and the launcher resolves dsh by walking up to
 * `<Resources>/harness/node_modules`, so these names are the contract at both ends.
 */
const stagedTreesWithOwnNodeModules = ["build/web", "build/harness"];

describe("electron-builder.yml", () => {
  it("builds an unsigned, un-notarized macOS dmg", () => {
    expect(config.mac.target).toEqual([{ target: "dmg", arch: ["arm64"] }]);
    expect(config.mac.identity).toBeNull();
    expect(config.mac.notarize).toBe(false);
    expect(config.afterSign).toBeUndefined();
  });

  it("ships the staged web server on disk, outside the archive", () => {
    expect(config.asar).toBe(true);
    // Native addons — the harness brings four Node-API ones — cannot be loaded from inside an asar.
    expect(config.asarUnpack).toContain("**/*.node");
  });

  it("copies the staged trees from above them, never each one as its own mapping", () => {
    // Both staged trees keep what they need in a `node_modules` at their own root: the standalone
    // server's `node_modules/next` is a relative symlink into `build/web/node_modules/.pnpm`, and the
    // harness is a 230-package npm installation under `build/harness/node_modules`. app-builder-lib's
    // `createFilter` opens with `if (relative === "node_modules") return false`, unconditionally and
    // before any pattern is consulted, so `from: build/web` and `from: build/harness` each silently
    // shipped their tree with its `node_modules` removed — an app that died on `Cannot find module
    // 'next'` before it had a window. One mapping from `build/` puts those directories at
    // `web/node_modules` and `harness/node_modules`, which the same function lets through.
    expect(config.extraResources).toEqual([{ from: "build", to: "." }]);
    for (const mapping of config.extraResources)
      expect(stagedTreesWithOwnNodeModules).not.toContain(mapping.from);
  });

  it("packs only the bundled entry points, so pnpm's symlinked node_modules is never walked", () => {
    expect(config.files).toEqual(["dist/**/*", "package.json"]);
  });

  it("keeps build output away from the staged packaging inputs under build/", () => {
    expect(config.directories.output).toBe("release");
    expect(config.directories.buildResources).not.toBe("build");
  });

  it("leaves a Windows target configured, so nothing here assumes macOS", () => {
    expect(config.win?.target?.[0]?.target).toBe("nsis");
  });
});
