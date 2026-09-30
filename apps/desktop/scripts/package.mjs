// Produces the unsigned macOS .dmg with electron-builder.
//
// Unsigned is a phase 2 decision, not an oversight: there is no Developer ID yet, so signing and
// notarization are switched off explicitly rather than left to auto-discovery, which would otherwise
// find a keychain identity on a developer's machine and produce a build nobody else can reproduce.
//
// A quarantined unsigned app does not open by double-click. The install note is in README.md, and it has
// to reach the user, or the first launch reads as "the build is broken".
//
// Usage: node scripts/package.mjs [--win]    (pnpm --filter @symplist/desktop package:mac)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(appDir, "package.json"));
const builderBin = require.resolve("electron-builder/out/cli/cli.js");

for (const required of [join(appDir, "dist", "main.js"), join(appDir, "build", "web")]) {
  if (existsSync(required)) continue;
  process.stderr.write(
    `desktop: ${required} is missing; run scripts/build.mjs and scripts/stage-web.mjs first\n`,
  );
  process.exit(2);
}

const target = process.argv.includes("--win") ? "--win" : "--mac";
const child = spawn(process.execPath, [builderBin, target], {
  cwd: appDir,
  stdio: "inherit",
  env: {
    ...process.env,
    // No identity is looked for, so the build is the same on every machine.
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  },
});
child.once("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
