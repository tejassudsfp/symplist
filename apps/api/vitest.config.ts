import { defineWorkspaceVitestConfig } from "../../packages/testing/src/vitest-config.ts";

// Nest needs legacy decorators and design:paramtypes metadata. Vite 8's Oxc transform provides both;
// they are set here explicitly because tsconfig.json excludes test files, so Oxc would not pick them
// up from it for *.test.ts (§17). The shared api test harness lives in test/ with its own tests.
export default defineWorkspaceVitestConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"] },
});
