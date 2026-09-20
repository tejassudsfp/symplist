import react from "@vitejs/plugin-react";
import { defineWorkspaceVitestConfig } from "../../packages/testing/src/vitest-config.ts";

export default defineWorkspaceVitestConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
