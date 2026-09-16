import { resourceCatalog } from "@trigger.dev/core/v3";
import "@trigger.dev/sdk/ai/test";
import { describe, expect, it, vi } from "vitest";
import type { WorkerRuntime } from "../../infra/runtime.ts";
import { runScheduledWork } from "../../infra/scheduling-runtime.ts";
import { cleanupHourlyTask } from "./cleanup-hourly.ts";
import { reminderScanTask } from "./reminder-scan.ts";

describe("bounded scheduled task declarations", () => {
  it("runs reminders on its singleton queue at 00, 15 and 30 UTC only", () => {
    expect(resourceCatalog.getTaskManifest(reminderScanTask.id)).toMatchObject({
      id: "reminder-scan",
      queue: { name: "reminder-scan" },
      machine: { preset: "micro" },
      maxDuration: 300,
      retry: { maxAttempts: 2 },
    });
    const source = readFileSync(new URL("./reminder-scan.ts", import.meta.url), "utf8");
    expect(source).toContain('pattern: "0,15,30 * * * *"');
    expect(source).toContain('timezone: "UTC"');
    expect(source).toContain('environments: ["PRODUCTION", "STAGING"]');
    expect(source).not.toContain("triggerAndWait");
  });
  it("runs hourly cleanup on the imported d1 family queue", () => {
    expect(resourceCatalog.getTaskManifest(cleanupHourlyTask.id)).toMatchObject({
      id: "cleanup-hourly",
      queue: { name: "d1" },
      machine: { preset: "micro" },
      retry: { maxAttempts: 2 },
    });
  });
  it.each(["scan", "cleanup"] as const)(
    "local mode makes no worker DB, provider or Trigger calls for %s",
    async (kind) => {
      const db = { first: vi.fn() };
      const events = { announce: vi.fn() };
      expect(
        await runScheduledWork(
          { config: { DURABLE: false }, db, events } as unknown as WorkerRuntime,
          kind,
        ),
      ).toEqual({ noop: true });
      expect(db.first).not.toHaveBeenCalled();
      expect(events.announce).not.toHaveBeenCalled();
    },
  );
  it("a persisted local executor makes a durable worker exit before touching user content", async () => {
    const db = { first: vi.fn(async () => null) };
    expect(
      await runScheduledWork({ config: { DURABLE: true }, db } as unknown as WorkerRuntime, "scan"),
    ).toEqual({ noop: true });
    expect(db.first).toHaveBeenCalledOnce();
  });
});

import { readFileSync } from "node:fs";
