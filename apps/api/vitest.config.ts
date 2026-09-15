import { defineWorkspaceVitestConfig } from "../../packages/testing/src/vitest-config.ts";

// Nest needs legacy decorators and design:paramtypes metadata. Vite 8's Oxc transform provides both;
// they are set here explicitly because tsconfig.json excludes test files, so Oxc would not pick them
// up from it for *.test.ts (§17).
export default defineWorkspaceVitestConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
});
