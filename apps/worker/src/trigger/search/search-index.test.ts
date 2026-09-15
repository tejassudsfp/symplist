import { resourceCatalog } from "@trigger.dev/core/v3";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { runInMockTaskContext } from "@trigger.dev/sdk/ai/test";
import { describe, expect, it } from "vitest";
import { searchIndex } from "./search-index.ts";

describe("search-index task (§8.8, §10.1)", () => {
  it("is registered on the d1 queue with three attempts that grow the machine after OOM", () => {
    expect(resourceCatalog.getTaskManifest(searchIndex.id)).toMatchObject({
      id: "search-index",
      queue: { name: "d1" },
      machine: { preset: "micro" },
      maxDuration: 300,
      retry: { maxAttempts: 3, outOfMemory: { machine: "small-1x" } },
    });
  });

  it("ends a run with an invalid payload at once instead of retrying it", async () => {
    const run = resourceCatalog.getTask(searchIndex.id)?.fns.run;
    expect(run).toBeTypeOf("function");
    await runInMockTaskContext(
      async ({ ctx }) => {
        const attempt = run?.({ ownerId: "not-a-uuid", query: "free text" }, {
          ctx,
          signal: new AbortController().signal,
        } as never);
        await expect(attempt).rejects.toBeInstanceOf(AbortTaskRunError);
        await expect(attempt).rejects.toMatchObject({ message: "search_index.payload_invalid" });
      },
      { ctx: { run: { id: "run_searchtest" }, attempt: { number: 1 } } as never },
    );
  });
});
