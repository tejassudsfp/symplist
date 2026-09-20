import { runOutputBodySchema } from "@symplist/core/events";
import { SimonRepository } from "@symplist/core/simon";
import {
  createKeyProvider,
  decryptFieldText,
  runChunkContext,
  verifyInternalRequest,
} from "@symplist/crypto";
import { FakeClock, FakeTriggerClient } from "@symplist/testing";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkerLogger } from "../../../apps/worker/src/infra/logger.ts";
import { RunOutputPushClient } from "../../../apps/worker/src/infra/run-output.ts";
import { createDocumentsTestEnvironment } from "../../core/src/documents/test-support.ts";
import type { SimonModel } from "./providers.ts";
import { runSimonTurn } from "./turn.ts";

const MARKER = "MARKER-simon-real-loop-plaintext-must-not-reach-trigger";
const API = "https://api.example.test";
type Chunk =
  Awaited<ReturnType<SimonModel["doStream"]>>["stream"] extends ReadableStream<infer T> ? T : never;

function stream(chunks: Chunk[], finish: "stop" | "tool-calls") {
  return {
    stream: new ReadableStream<Chunk>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.enqueue({
          type: "finish",
          finishReason: { unified: finish, raw: undefined },
          usage: {
            inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 3, text: 3, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
  };
}

describe("real Simon loop Trigger content boundary (§8.3)", () => {
  it("keeps user, document, arguments, result, reasoning and provider errors out of every Trigger sink", async () => {
    const env = await createDocumentsTestEnvironment();
    const signer = createKeyProvider(
      { INTERNAL_EVENT_SECRET: { current: 1, versions: new Map([[1, Buffer.alloc(32, 7)]]) } },
      { required: ["INTERNAL_EVENT_SECRET"] },
    );
    try {
      const clock = new FakeClock(env.clock);
      const trigger = new FakeTriggerClient({ clock });
      const logger = createWorkerLogger(trigger.logger);
      const repository = new SimonRepository({
        db: env.db,
        keys: env.keys,
        now: () => env.clock,
        policy: { betaAccessRequired: true },
        quickChatTtlHours: 24,
      });
      await env.db.run({ sql: "UPDATE executor_state SET mode = 'durable'", params: [] });
      const owner = await env.createUser();
      const taskId = await env.createTask(owner);
      const published = await env.tools.updateSection(env.simon(owner, taskId), {
        taskId,
        expectedRevision: null,
        placement: "end",
        markdown: `## Private section\n${MARKER}`,
      });
      const outline = await env.tools.outline(env.simon(owner, taskId), { taskId });
      const sectionId = outline.entries[0]?.sectionId;
      expect(sectionId).toBeDefined();
      const conversation = await repository.createConversation(owner, taskId);
      const accepted = await repository.acceptMessage(owner, conversation, "marker-success", {
        text: `Read ${MARKER}`,
        tier: "fast",
      });
      if (!accepted.runId) throw new Error("missing accepted run");
      const bodies: Buffer[] = [];
      let toolCalls = 0;
      let modelCalls = 0;
      const model = new MockLanguageModelV4({
        doStream: async () => {
          modelCalls += 1;
          return modelCalls === 1
            ? stream(
                [
                  { type: "reasoning-start", id: "reasoning" },
                  { type: "reasoning-delta", id: "reasoning", delta: MARKER },
                  { type: "reasoning-end", id: "reasoning" },
                  {
                    type: "tool-call",
                    toolCallId: "marker_read",
                    toolName: "read_probe",
                    input: JSON.stringify({ query: MARKER }),
                  },
                ],
                "tool-calls",
              )
            : stream(
                [
                  { type: "text-start", id: "reply" },
                  { type: "text-delta", id: "reply", delta: `Read result ${MARKER}` },
                  { type: "text-end", id: "reply" },
                ],
                "stop",
              );
        },
      });
      let providerFails = false;
      trigger.registerTask(
        "simon-run",
        async (payload, { ctx, signal }) => {
          const runId = (payload as { runId: string }).runId;
          const result = await runSimonTurn(runId, {
            repository,
            executor: "trigger",
            signal,
            telemetryEnabled: true,
            models: {
              resolve: () => {
                if (providerFails)
                  throw Object.assign(new Error(MARKER), {
                    responseBody: MARKER,
                    requestBodyValues: { prompt: MARKER },
                  });
                return { provider: "scripted", modelId: "scripted", model };
              },
            },
            log: (event) => logger.warn("simon.run_event", { code: event.code, runId }),
            tools: async () => ({
              read_probe: tool({
                inputSchema: z.object({ query: z.string() }),
                execute: async ({ query }) => {
                  expect(query).toBe(MARKER);
                  toolCalls += 1;
                  const result = await env.tools.readSection(env.simon(owner, taskId), {
                    taskId,
                    sectionId: String(sectionId),
                    revision: String(published.revision),
                  });
                  expect(result.output.text).toContain(MARKER);
                  return result.output;
                },
              }),
            }),
            sink: (claim) =>
              new RunOutputPushClient({
                runId,
                ownerId: owner,
                attempt: ctx.attempt.number,
                accountKey: claim.key,
                keys: signer,
                apiOrigin: API,
                logger,
                timers: clock,
                fetch: async (url, init) => {
                  const body = Buffer.from(init.body as Uint8Array);
                  const headers = init.headers as Record<string, string>;
                  expect(
                    verifyInternalRequest(
                      signer,
                      {
                        timestamp: headers["x-sym-timestamp"],
                        eventId: headers["x-sym-event-id"],
                        keyVersion: headers["x-sym-key"],
                        signature: headers["x-sym-signature"],
                        method: "POST",
                        path: url.slice(API.length),
                        body,
                      },
                      { nowMs: clock.now() },
                    ).ok,
                  ).toBe(true);
                  bodies.push(body);
                  return new Response(null, { status: 202 });
                },
              }),
          });
          trigger.metadata.set("steps", result.steps);
          logger.info("simon.completed", { runId, stepCount: result.steps });
          return result;
        },
        { maxAttempts: 1 },
      );
      const handle = await trigger.tasks.trigger(
        "simon-run",
        { runId: accepted.runId },
        { idempotencyKey: accepted.runId, tags: [`run:${accepted.runId}`] },
      );
      await trigger.runUntilIdle();
      expect((await trigger.runs.retrieve(handle.id)).output).toEqual({
        status: "completed",
        steps: 2,
      });
      expect(toolCalls).toBe(1);
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(MARKER);
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.every((body) => !body.includes(MARKER))).toBe(true);
      const key = await repository.accountKeys.load(owner);
      if (!key) throw new Error("missing account key");
      try {
        const chunks = bodies.flatMap((body) => {
          const value = runOutputBodySchema.parse(JSON.parse(body.toString("utf8")));
          return JSON.parse(
            decryptFieldText(key, runChunkContext(owner, value.runId, value.seq), value.envelope),
          ) as { type: string }[];
        });
        expect(JSON.stringify(chunks)).toContain(MARKER);
        expect(chunks.some((chunk) => chunk.type.startsWith("reasoning"))).toBe(false);
      } finally {
        key.key.fill(0);
      }
      for (const table of [
        "messages",
        "message_parts",
        "runs",
        "tool_invocations",
        "doc_repos",
        "doc_commits",
      ]) {
        expect(
          JSON.stringify(await env.db.all({ sql: `SELECT * FROM ${table}`, params: [] })),
        ).not.toContain(MARKER);
      }
      providerFails = true;
      const failing = await repository.acceptMessage(owner, conversation, "marker-failure", {
        text: MARKER,
        tier: "fast",
      });
      const failed = await trigger.tasks.trigger(
        "simon-run",
        { runId: failing.runId },
        { idempotencyKey: String(failing.runId) },
      );
      await trigger.runUntilIdle();
      expect((await trigger.runs.retrieve(failed.id)).error).toMatchObject({
        message: "ai.provider_failed",
      });
      expect(trigger.errors).toHaveLength(1);
      expect(trigger.logs.length).toBeGreaterThan(0);
      expect(trigger.metadataWrites.length).toBeGreaterThan(0);
      expect(trigger.findMarker(MARKER)).toEqual([]);
    } finally {
      signer.destroy();
      await env.close();
    }
  });
});
