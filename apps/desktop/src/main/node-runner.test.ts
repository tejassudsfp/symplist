import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeRunnerPath } from "./node-runner.ts";

/**
 * Which binary a Node child is spawned from.
 *
 * The bug this guards is only visible to a person looking at their Dock: spawning the bundle's own
 * `MacOS/Symplist` gives the child a second icon, because that bundle has no `LSUIElement`. Nothing
 * fails, nothing logs, and the app works — it just looks like two apps opened.
 */

const dirs: string[] = [];

function appBundle(options: { readonly withHelper: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "symplist-runner-"));
  dirs.push(root);
  const macOs = join(root, "Symplist.app", "Contents", "MacOS");
  mkdirSync(macOs, { recursive: true });
  const execPath = join(macOs, "Symplist");
  writeFileSync(execPath, "");
  if (options.withHelper) {
    const helperDir = join(
      root,
      "Symplist.app",
      "Contents",
      "Frameworks",
      "Symplist Helper.app",
      "Contents",
      "MacOS",
    );
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(join(helperDir, "Symplist Helper"), "");
  }
  return execPath;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the binary a Node child is spawned from", () => {
  it.skipIf(process.platform !== "darwin")(
    "prefers the helper, which carries LSUIElement and so takes no Dock icon",
    () => {
      const execPath = appBundle({ withHelper: true });
      expect(nodeRunnerPath(execPath)).toBe(
        execPath.replace(
          "/Contents/MacOS/Symplist",
          "/Contents/Frameworks/Symplist Helper.app/Contents/MacOS/Symplist Helper",
        ),
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "falls back when no helper is there, which is what a dev run looks like",
    () => {
      // In development `execPath` is Electron inside node_modules, not an app bundle, and there is
      // no helper to prefer. Deciding on the file's existence rather than on a packaging flag keeps
      // that case honest.
      const execPath = appBundle({ withHelper: false });
      expect(nodeRunnerPath(execPath)).toBe(execPath);
    },
  );

  it("leaves a path that is not an app bundle alone", () => {
    expect(nodeRunnerPath("/usr/local/bin/node")).toBe("/usr/local/bin/node");
  });
});
