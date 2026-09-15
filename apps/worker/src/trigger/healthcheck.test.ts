import { resourceCatalog } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/sdk/ai/test";
import { describe, expect, it } from "vitest";
import { healthcheck } from "./healthcheck.ts";

describe("symplist-healthcheck task", () => {
  it("is registered with one attempt and no D1 queue", () => {
    const manifest = resourceCatalog.getTaskManifest(healthcheck.id);
    expect(manifest).toMatchObject({ id: "symplist-healthcheck", retry: { maxAttempts: 1 } });
    expect(["d1", "d1-git", "reminder-scan"]).not.toContain(manifest?.queue?.name);
  });

  it("runs offline in a mock task context and reports the runtime", async () => {
    const run = resourceCatalog.getTask(healthcheck.id)?.fns.run;
    expect(run).toBeTypeOf("function");
    await runInMockTaskContext(
      async ({ ctx }) => {
        const report = (await run?.({}, {
          ctx,
          signal: new AbortController().signal,
        } as never)) as {
          node: string;
          rssMb: number;
        };
        expect(report.node).toBe(process.version);
        expect(report.rssMb).toBeGreaterThan(0);
      },
      { ctx: { run: { id: "run_healthcheck" }, attempt: { number: 1 } } as never },
    );
  });
});
