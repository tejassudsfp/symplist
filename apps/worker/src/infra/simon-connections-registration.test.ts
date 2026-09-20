import * as agent from "@symplist/agent";
import { sql, uuidv7 } from "@symplist/db";
import { expect, it, vi } from "vitest";
import { createDocumentsTestEnvironment } from "../../../../packages/core/src/documents/test-support.ts";
import { runDurableSimon } from "../trigger/simon/simon-run.ts";
import type { WorkerRuntime } from "./runtime.ts";

vi.mock("@symplist/agent", async (original) => ({
  ...(await original<typeof agent>()),
  createSimonModels: vi.fn(),
  runSimonTurn: vi.fn(),
  simonApprovedConnectionEffect: vi.fn(() => vi.fn()),
  simonConnectionTools: vi.fn(() => ({})),
  simonNativeTools: vi.fn(() => ({})),
  simonSharingTools: vi.fn(() => ({})),
}));

it("registers the same Connections tools and approved effect in the durable executor", async () => {
  const env = await createDocumentsTestEnvironment();
  try {
    const owner = await env.createUser();
    const taskId = await env.createTask(owner);
    await env.db.run(sql("UPDATE executor_state SET mode='durable'"));
    const runtime = {
      config: {
        DURABLE: true,
        BETA_ACCESS_REQUIRED: true,
        QUICK_CHAT_TTL_HOURS: 24,
        AI_TELEMETRY_ENABLED: false,
        REMINDERS_ENABLED: true,
        REMINDER_EMAIL_ENABLED: false,
        DEFAULT_TIMEZONE: "UTC",
        DOC_MAX_BYTES: 1_048_576,
        WEB_ORIGIN: "https://app.example.test",
        API_ORIGIN: "https://api.example.test",
      },
      db: env.db,
      keys: env.keys,
      objects: env.objects,
      events: { announce: vi.fn(async () => {}) },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as unknown as WorkerRuntime;
    vi.mocked(agent.runSimonTurn).mockImplementation(async (_id, dependencies) => {
      const conversation = await dependencies.repository.createConversation(owner, taskId);
      const accepted = await dependencies.repository.acceptMessage(owner, conversation, "factory", {
        text: "Prepare",
        tier: "fast",
      });
      const claim = await dependencies.repository.claim(String(accepted.runId), "trigger");
      if (!claim) throw new Error("Missing claim");
      try {
        const context = {
          repository: dependencies.repository,
          claim,
          signal: new AbortController().signal,
          requestApproval: () => {
            throw new Error("Unexpected approval");
          },
        };
        await dependencies.tools?.(context);
        await dependencies.approvedEffect?.(context);
      } finally {
        dependencies.repository.releaseClaim(claim);
      }
      return { status: "completed", steps: 0 };
    });

    await expect(runDurableSimon({ runId: uuidv7() }, runtime, 1)).resolves.toEqual({
      status: "completed",
      steps: 0,
    });
    expect(agent.simonConnectionTools).toHaveBeenCalledTimes(1);
    expect(agent.simonApprovedConnectionEffect).toHaveBeenCalledTimes(1);
    const options = vi.mocked(agent.simonConnectionTools).mock.calls[0]?.[1];
    expect(await options?.authority.check()).toBe(true);
    expect(options?.external).toBeTypeOf("function");
    expect(options?.resolveArguments).toBeTypeOf("function");
  } finally {
    vi.clearAllMocks();
    await env.close();
  }
});
