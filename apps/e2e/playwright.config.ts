import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.E2E_WEB_PORT ?? 3000);
const apiPort = Number(process.env.E2E_API_PORT ?? 4000);
const webUrl = process.env.E2E_WEB_URL ?? `http://127.0.0.1:${webPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const startApi = fileURLToPath(new URL("./src/start-api.ts", import.meta.url));

/**
 * Public origins baked into the production build. They must be the same host the api is started on,
 * because the browser only sends the session cookie to the host the web app actually calls.
 */
const webBuildEnv = {
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? apiUrl,
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? `ws://127.0.0.1:${apiPort}`,
};

/**
 * End-to-end, accessibility and visual tests at the three verified viewports (§17). The web app runs
 * as a production build (`next build`, then `next start`); the api runs from its own build on local
 * drivers with a throwaway data directory (§16.1), so the api-backed specs sign in against it.
 *
 * `shell.spec.ts` deliberately asserts the shell with the api refusing every read, which is a state
 * the app has to be honest about; `workspace.spec.ts` signs in and drives the real flows.
 */
export default defineConfig({
  testDir: "./tests",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  snapshotPathTemplate:
    "{testDir}/__screenshots__/{platform}/{projectName}/{testFilePath}/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" } },
  use: { baseURL: webUrl, trace: "on-first-retry" },
  webServer: process.env.E2E_WEB_URL
    ? undefined
    : [
        {
          command: `pnpm --filter @symplist/web build && pnpm --filter @symplist/web exec next start --hostname 127.0.0.1 --port ${webPort}`,
          cwd: repoRoot,
          url: `${webUrl}/now`,
          env: webBuildEnv,
          timeout: 300_000,
          // Never attach to a server started elsewhere (for example another worktree on the same port).
          reuseExistingServer: false,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: `pnpm exec tsc -b tsconfig.build.json && node ${JSON.stringify(startApi)}`,
          cwd: repoRoot,
          url: `${apiUrl}/healthz`,
          env: { E2E_API_PORT: String(apiPort), E2E_WEB_PORT: String(webPort) },
          timeout: 300_000,
          reuseExistingServer: false,
          stdout: "pipe",
          stderr: "pipe",
        },
      ],
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "laptop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 720 } },
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
  ],
});
