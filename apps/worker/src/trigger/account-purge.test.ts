import { resourceCatalog } from "@trigger.dev/core/v3";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { runInMockTaskContext } from "@trigger.dev/sdk/ai/test";
import { describe, expect, it } from "vitest";
import { accountPurge } from "./account-purge.ts";

describe("account-purge task (§5.6, §8.8)", () => {
  it("is registered on the d1 queue with an explicit retry that grows the machine after OOM", () => {
    const manifest = resourceCatalog.getTaskManifest(accountPurge.id);
    expect(manifest).toMatchObject({
      id: "account-purge",
      queue: { name: "d1" },
      machine: { preset: "micro" },
      maxDuration: 900,
      retry: { maxAttempts: 5, outOfMemory: { machine: "small-1x" } },
    });
  });

  it("ends a run with an invalid payload at once instead of retrying it", async () => {
    const run = resourceCatalog.getTask(accountPurge.id)?.fns.run;
    expect(run).toBeTypeOf("function");
    await runInMockTaskContext(
      async ({ ctx }) => {
        const attempt = run?.({ userId: "not-a-uuid", note: "free text" }, {
          ctx,
          signal: new AbortController().signal,
        } as never);
        await expect(attempt).rejects.toBeInstanceOf(AbortTaskRunError);
        await expect(attempt).rejects.toMatchObject({ message: "account_purge.payload_invalid" });
      },
      { ctx: { run: { id: "run_purgetest" }, attempt: { number: 1 } } as never },
    );
  });
});
