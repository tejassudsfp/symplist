// Runs the app from the workspace, without packaging it.
//
//   node scripts/build.mjs && node scripts/start.mjs
//
// It loads the staged standalone server from build/web (run scripts/stage-web.mjs once), unless
// SYMPLIST_DESKTOP_DEV_SERVER_URL points at a `next dev` server — the single switch between development
// and a packaged app:
//
//   pnpm --filter @symplist/web dev
//   SYMPLIST_DESKTOP_DEV_SERVER_URL=http://127.0.0.1:3000 node scripts/start.mjs
//
// Usage: node scripts/start.mjs    (pnpm --filter @symplist/desktop start)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const mainBundle = fileURLToPath(new URL("../dist/main.js", import.meta.url));

if (!existsSync(mainBundle)) {
  process.stderr.write("desktop: dist/main.js is missing; run node scripts/build.mjs first\n");
  process.exit(2);
}

const child = spawn(electronPath, [appDir, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.once("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
