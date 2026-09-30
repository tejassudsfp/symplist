// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Electron line is pinned for its bundled Node, not for its Chromium: dsh is built for node-24 and
 * the repo's engines refuse anything else, so an Electron whose Node drifts out of that range is a
 * broken app rather than an upgrade. The version is asserted against the binary that will ship, because
 * the release notes are not the runtime.
 */
// At import time, not inside the test: `require("electron")` downloads the runtime on a fresh clone,
// and a download does not belong inside a timed assertion.
const require = createRequire(import.meta.url);
const electronBinary = require("electron") as unknown as string;

function packageJson(url: string): {
  engines?: { node?: string };
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8"));
}

function versionParts(version: string): [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = version.split(".");
  return [Number(major), Number(minor), Number(patch)];
}

function atLeast(version: string, minimum: string): boolean {
  const [major, minor, patch] = versionParts(version);
  const [minMajor, minMinor, minPatch] = versionParts(minimum);
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

describe("the Electron runtime", () => {
  it("bundles a Node that satisfies the repo's engines range", () => {
    const engines = packageJson("../../../../package.json").engines?.node ?? "";
    const minimum = /^>=\s*([\d.]+)/.exec(engines)?.[1];
    const exclusiveMajor = /<\s*(\d+)/.exec(engines)?.[1];
    expect(minimum, `unexpected engines.node: ${engines}`).toBeTypeOf("string");
    expect(exclusiveMajor, `unexpected engines.node: ${engines}`).toBeTypeOf("string");

    const versions = JSON.parse(
      execFileSync(
        electronBinary,
        ["-e", "process.stdout.write(JSON.stringify(process.versions))"],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" },
      ),
    ) as { node: string; electron: string };

    expect(atLeast(versions.node, String(minimum))).toBe(true);
    expect(versionParts(versions.node)[0]).toBeLessThan(Number(exclusiveMajor));

    // The binary on disk is the version this package pins, not whatever a cache happened to hold.
    const pinned = packageJson("../../package.json").devDependencies?.electron;
    expect(versions.electron).toBe(pinned);
  }, 30_000);
});
