import { SimonRepository } from "@symplist/core/simon";
import { createScriptedModel, scriptedText, scriptedToolCall } from "@symplist/testing";
import { describe, expect, it, vi } from "vitest";
import { createDocumentsTestEnvironment } from "../../core/src/documents/test-support.ts";
import { simonNativeTools } from "./native.ts";
import { runSimonTurn } from "./turn.ts";

describe("native task and schedule model-loop parity", () => {
  it.each(["local", "trigger"] as const)(
    "executes and checkpoints native tools under %s",
    async (executor) => {
      const env = await createDocumentsTestEnvironment();
      try {
        await env.db.run({
          sql: "UPDATE executor_state SET mode=?",
          params: [executor === "local" ? "local" : "durable"],
        });
        const owner = await env.createUser();
        const taskId = await env.createTask(owner);
        const repository = new SimonRepository({
          db: env.db,
          keys: env.keys,
          now: () => env.clock,
          policy: { betaAccessRequired: true },
          quickChatTtlHours: 24,
        });
        const conversation = await repository.createConversation(owner, null);
        const accepted = await repository.acceptMessage(owner, conversation, "native-contract", {
          text: "Organize these tasks",
          tier: "fast",
        });
        const schedule = {
          taskId,
          operation: "set_deadline",
          expectedVersion: 0,
          deadline: { kind: "date", date: "2026-10-01", zone: "UTC" },
        };
        const script = createScriptedModel([
          scriptedToolCall("task_create", { title: "Native private title", collection: "now" }),
          scriptedToolCall("task_move", { taskId, collection: "later" }),
          scriptedToolCall("task_schedule", schedule),
          scriptedToolCall("task_schedule", schedule),
          scriptedText("Moved the task and saved its deadline; the stale update was refused."),
        ]);
        const result = await runSimonTurn(accepted.runId ?? "", {
          repository,
          executor,
          models: {
            resolve: () => ({
              provider: "scripted",
              modelId: script.model.modelId,
              model: script.model,
            }),
          },
          signal: new AbortController().signal,
          telemetryEnabled: false,
          log: vi.fn(),
          tools: async (context) =>
            simonNativeTools(context, {
              scheduling: { remindersEnabled: true, emailEnabled: false },
            }),
          sink: () => ({ write: vi.fn(), flush: async () => {}, close: async () => {} }),
        });
        expect(result).toEqual({ status: "completed", steps: 5 });
        expect(script.remaining()).toBe(0);
        expect(JSON.stringify(script.calls.at(-1)?.prompt)).toContain("schedule.conflict");
        expect(
          await env.db.first({ sql: "SELECT collection FROM tasks WHERE id=?", params: [taskId] }),
        ).toEqual({ collection: "later" });
        expect(
          await env.db.first({
            sql: "SELECT version,deadline_date FROM task_schedules WHERE task_id=?",
            params: [taskId],
          }),
        ).toEqual({ version: 1, deadline_date: "2026-10-01" });
        const rows = await env.db.all({
          sql: "SELECT title_enc FROM tasks WHERE owner_id=?",
          params: [owner],
        });
        expect(rows).toHaveLength(2);
        expect(JSON.stringify(rows)).not.toContain("Native private title");
        const parts = await env.db.all({
          sql: "SELECT content_enc FROM message_parts",
          params: [],
        });
        expect(parts.length).toBeGreaterThan(0);
        expect(JSON.stringify(parts)).not.toContain("Native private title");
      } finally {
        await env.close();
      }
    },
  );
});
