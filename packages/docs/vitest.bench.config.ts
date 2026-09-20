import { defineConfig } from "vitest/config";
import { workspaceSourcePlugin } from "../testing/src/vitest-config.ts";

/**
 * The document history benchmark (note 11 "measure cold and warm latency"). Not part of `pnpm test`:
 * run it with `pnpm --filter @symplist/docs exec vitest run --config vitest.bench.config.ts`.
 */
export default defineConfig({
  plugins: [workspaceSourcePlugin()],
  test: {
    include: ["bench/**/*.bench.ts"],
    environment: "node",
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
  },
});
