import { resourceCatalog } from "@trigger.dev/core/v3";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { runInMockTaskContext } from "@trigger.dev/sdk/ai/test";
import { describe, expect, it } from "vitest";
import { simonRun } from "./simon-run.ts";

describe("simon-run task registration", () => {
  it("uses d1/micro, a ten-minute queue TTL and exactly one attempt", () => {
    expect(resourceCatalog.getTaskManifest(simonRun.id)).toMatchObject({
      id: "simon-run",
      queue: { name: "d1" },
      machine: { preset: "micro" },
      retry: { maxAttempts: 1 },
      ttl: "10m",
      maxDuration: 900,
    });
  });
  it("rejects content-bearing payloads before loading runtime configuration", async () => {
    const run = resourceCatalog.getTask(simonRun.id)?.fns.run;
    expect(run).toBeDefined();
    await runInMockTaskContext(
      async ({ ctx }) => {
        const result = run?.(
          { runId: "0192f0a0-0000-7000-8000-000000000601", text: "private marker" },
          { ctx, signal: new AbortController().signal } as never,
        );
        await expect(result).rejects.toBeInstanceOf(AbortTaskRunError);
        await expect(result).rejects.toMatchObject({ message: "simon.payload_invalid" });
      },
      { ctx: { run: { id: "run_simontest" }, attempt: { number: 1 } } as never },
    );
  });
});
