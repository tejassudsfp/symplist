import { aptGet } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_rryekrktnjnrdzvabzqd",
  runtime: "node-24",
  dirs: ["./src/trigger"],
  // Default ceiling in seconds; long-running tasks override it per task.
  maxDuration: 900,
  // Most tasks fit on micro; Git document tasks opt into small-1x per task.
  machine: "micro",
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10_000,
      factor: 2,
      randomize: true,
    },
  },
  build: {
    // Bundle workspace packages from their TypeScript sources, so deploys never need a prior build (§2.2).
    conditions: ["source"],
    // Document history uses the Git CLI inside deployed tasks.
    extensions: [aptGet({ packages: ["git"] })],
  },
});
