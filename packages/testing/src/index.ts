/**
 * Test support shared across the workspace (§17): fakes, fixtures (the Maya dataset) and contract
 * suites under `src/contracts/` that run against every implementation of an interface. The shared
 * Vitest config is exported separately as `@symplist/testing/vitest`.
 */
export * from "./fakes/index.ts";
export * from "./fixtures/index.ts";
