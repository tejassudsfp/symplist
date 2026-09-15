import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.E2E_WEB_PORT ?? 3000);
const webUrl = process.env.E2E_WEB_URL ?? `http://127.0.0.1:${webPort}`;
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Public origins baked into the production build; the shell spec needs no running api. */
const webBuildEnv = {
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000",
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? "ws://127.0.0.1:4000",
};

/**
 * End-to-end, accessibility and visual tests at the three verified viewports (§17). The web app runs
 * as a production build (`next build`, then `next start`). The api (local drivers, scripted model)
 * joins as a second `webServer` entry when the first api-backed flows land.
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
    : {
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
