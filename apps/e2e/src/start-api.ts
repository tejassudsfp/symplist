// Starts the api Playwright's second `webServer` entry runs: local drivers, a scripted model and a
// throwaway data directory, with secrets generated for this run and written beside it so the suite's
// own session seeding uses the same keys (`helpers/session.ts`). Nothing here is committed.
//
// Usage: node apps/e2e/src/start-api.ts      (from the repository root, through playwright.config.ts)
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { e2eApiEnv, RUN_DIR, writeRunEnv } from "./helpers/local-api.ts";

const apiPort = Number(process.env.E2E_API_PORT ?? 4000);
const webPort = Number(process.env.E2E_WEB_PORT ?? 3000);
const apiEntry = fileURLToPath(new URL("../../api/dist/main.js", import.meta.url));

// Every run starts from an empty account store, so a spec never sees another run's tasks.
rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(RUN_DIR, { recursive: true });

const env = e2eApiEnv({ apiPort, webPort });
writeRunEnv(env);

const api = spawn(process.execPath, ["--enable-source-maps", apiEntry], {
  cwd: RUN_DIR,
  env,
  stdio: "inherit",
});

const stop = (signal: NodeJS.Signals) => {
  api.kill(signal);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
api.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
