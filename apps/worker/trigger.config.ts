import { aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";
// The Trigger CLI loads this file with jiti, which resolves workspace packages to `dist` rather than
// their `source` export, so the worker allowlist is imported from its TypeScript source by path.
import {
  workerImageEnvInstructions,
  workerSyncEnvVarsWhenPresent,
} from "../../packages/config/src/worker.ts";
import { guardedSyncEnvVars, imageEnvExtension } from "./src/infra/build-extensions.ts";

export default defineConfig({
  project: "proj_rryekrktnjnrdzvabzqd",
  runtime: "node-24",
  dirs: ["./src/trigger"],
  // Default ceiling in seconds; long-running tasks override it per task (§8.8).
  maxDuration: 900,
  // Most tasks fit on micro; Git document tasks opt into small-1x per task (§8.8, decision A3).
  machine: "micro",
  retries: {
    enabledInDev: false,
    // Every task declares its own retry explicitly; nothing is retried by default (§8.8).
    default: { maxAttempts: 1 },
  },
  build: {
    // Bundle workspace packages from their TypeScript sources, so deploys never need a prior build (§2.2).
    conditions: ["source"],
    extensions: [
      // Document history uses the Git CLI inside deployed tasks (§9.1).
      aptGet({ packages: ["git"] }),
      // Linked GitHub builds receive no runtime secrets and preserve Trigger-managed values. A
      // credentialed CLI deploy receives the worker env and must validate the complete allowlist.
      syncEnvVars(guardedSyncEnvVars(() => workerSyncEnvVarsWhenPresent(process.env))),
      // TRIGGER_AI_SDK_OTEL_AUTOREGISTER=0 is set for the image and run environment; sync drops TRIGGER_* (§8.3).
      imageEnvExtension(workerImageEnvInstructions),
    ],
  },
});
