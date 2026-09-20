import { resourceCatalog } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/sdk/ai/test";
import { describe, expect, it, vi } from "vitest";
import { connectionsReconcile } from "./connections-reconcile.ts";

vi.mock("../../infra/runtime.ts", () => ({
  workerRuntime: () => ({
    db: { first: async () => ({ mode: "local", generation: 2 }) },
    d1Counters: { flush: () => undefined },
  }),
}));
vi.mock("../../infra/d1-counters.ts", () => ({
  reportingD1Counters: async (_counters: unknown, _context: unknown, run: () => Promise<unknown>) =>
    run(),
}));

describe("connection reconciliation Trigger declaration", () => {
  it("uses the shared d1 lane, micro machine and bounded retry/TTL", () => {
    expect(resourceCatalog.getTaskManifest(connectionsReconcile.id)).toMatchObject({
      id: "connections-reconcile",
      queue: { name: "d1" },
      machine: { preset: "micro" },
      retry: { maxAttempts: 2 },
      ttl: "1h",
      maxDuration: 3600,
      schedule: { cron: "20 3 * * *", timezone: "UTC", environments: ["PRODUCTION", "STAGING"] },
    });
  });
  it("stops before loading Composio when durable mode has ended", async () => {
    const run = resourceCatalog.getTask(connectionsReconcile.id)?.fns.run;
    expect(run).toBeDefined();
    await runInMockTaskContext(
      async ({ ctx }) => {
        await expect(
          run?.({}, { ctx, signal: new AbortController().signal } as never),
        ).resolves.toEqual({ status: "stale" });
      },
      { ctx: { run: { id: "run_connections" } } as never },
    );
  });
});
