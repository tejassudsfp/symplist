import { runOutputBodySchema } from "@symplist/core/events";
import {
  type AccountDataKey,
  createAccountKey,
  createKeyProvider,
  decryptFieldText,
  encryptFieldText,
  runChunkContext,
  verifyInternalRequest,
} from "@symplist/crypto";
import { uuidv7 } from "@symplist/db";
import { FakeClock, FakeTriggerClient, findMarkerIn } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import { toWorkerError } from "./errors.ts";
import { InternalEventClient } from "./internal-events.ts";
import { createWorkerLogger } from "./logger.ts";
import { RunOutputPushClient } from "./run-output.ts";
import type { WorkerFetch } from "./signed-request.ts";

/**
 * §8.3 negative test: a scripted durable turn whose user message, document section, tool arguments
 * and tool result all contain a marker runs through the fake Trigger client, the run output push
 * client and the redacting logger. The marker must reach the api only inside encrypted envelopes and
 * must appear in no Trigger payload, option, tag, metadata, output, thrown error or logger call.
 */
const MARKER = "MARKER-c0ffee-4d1b-never-in-trigger";
const API = "https://api.example.com";

const keys = createKeyProvider({
  CONTENT_KEK: { current: 1, versions: new Map([[1, Buffer.alloc(32, 3).toString("base64url")]]) },
  INTERNAL_EVENT_SECRET: {
    current: 1,
    versions: new Map([[1, Buffer.alloc(32, 4).toString("base64url")]]),
  },
});

interface StoredRun {
  readonly ownerId: string;
  readonly conversationId: string;
  /** The user message and a document section as they sit in D1: field envelopes. */
  readonly messageEnc: string;
  readonly sectionEnc: string;
}

function scriptedModel(message: string, section: string) {
  // What a model turn streams: reasoning text quoting the inputs, a tool call and its result.
  return [
    { type: "start" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: `You asked: ${message}` },
    {
      type: "tool-input-available",
      toolCallId: "call_1",
      toolName: "task_document_update_section",
      input: { sectionId: "s1", markdown: `# ${section}` },
    },
    {
      type: "tool-output-available",
      toolCallId: "call_1",
      output: { status: "updated", preview: section },
    },
    { type: "text-delta", id: "t1", delta: `Done with ${message}` },
    { type: "text-end", id: "t1" },
    { type: "finish" },
  ];
}

describe("Trigger hygiene marker test (§8.3)", () => {
  it("keeps content out of every Trigger-hosted sink during a scripted durable turn", async () => {
    const clock = new FakeClock(Date.UTC(2026, 8, 15, 14));
    const trigger = new FakeTriggerClient({ clock });
    const ownerId = uuidv7();
    const runId = uuidv7();
    const { key } = createAccountKey(keys, ownerId);
    const accountKey: AccountDataKey = key;
    const store = new Map<string, StoredRun>([
      [
        runId,
        {
          ownerId,
          conversationId: uuidv7(),
          messageEnc: encryptFieldText(
            accountKey,
            {
              purpose: "message",
              ownerId,
              table: "message_parts",
              rowId: "m1",
              column: "text_enc",
            },
            `Please rewrite ${MARKER}`,
          ),
          sectionEnc: encryptFieldText(
            accountKey,
            { purpose: "doc", ownerId, table: "doc_repos", rowId: "d1", column: "head_enc" },
            `Section about ${MARKER}`,
          ),
        },
      ],
    ]);

    const apiBodies: { path: string; body: Buffer; verified: boolean }[] = [];
    const apiFetch: WorkerFetch = async (url, init) => {
      const headers = init.headers as Record<string, string>;
      const body = Buffer.from(init.body as Uint8Array);
      const path = url.slice(API.length);
      const verified = verifyInternalRequest(
        keys,
        {
          timestamp: headers["x-sym-timestamp"],
          eventId: headers["x-sym-event-id"],
          keyVersion: headers["x-sym-key"],
          signature: headers["x-sym-signature"],
          method: "POST",
          path,
          body,
        },
        { nowMs: clock.now() },
      ).ok;
      apiBodies.push({ path, body, verified });
      return new Response(null, { status: 202 });
    };

    trigger.registerTask(
      "simon-run",
      async (payload, { ctx }) => {
        const { runId: id } = payload as { runId: string };
        const run = store.get(id);
        if (!run) throw new Error("missing run");
        const logger = createWorkerLogger(trigger.logger);
        const message = decryptFieldText(
          accountKey,
          {
            purpose: "message",
            ownerId: run.ownerId,
            table: "message_parts",
            rowId: "m1",
            column: "text_enc",
          },
          run.messageEnc,
        );
        const section = decryptFieldText(
          accountKey,
          {
            purpose: "doc",
            ownerId: run.ownerId,
            table: "doc_repos",
            rowId: "d1",
            column: "head_enc",
          },
          run.sectionEnc,
        );

        const sink = new RunOutputPushClient({
          runId: id,
          ownerId: run.ownerId,
          attempt: ctx.attempt.number,
          accountKey,
          keys,
          apiOrigin: API,
          logger,
          fetch: apiFetch,
          timers: clock,
        });
        const started = clock.now();
        for (const chunk of scriptedModel(message, section)) {
          sink.write(chunk);
          // A careless call site passing content: the logger must drop every such field.
          logger.info("run.chunk_written", {
            runId: id,
            chunkType: chunk.type,
            text: message,
            toolArgs: section,
            detailId: message,
          });
        }
        const stats = await sink.close();

        trigger.metadata.set("steps", 1);
        trigger.metadata.set("chunksSent", stats.chunksSent);
        const events = new InternalEventClient({
          keys,
          apiOrigin: API,
          logger,
          fetch: apiFetch,
          timers: clock,
        });
        await events.announce({
          type: "document.head_changed",
          ownerId: run.ownerId,
          payload: { taskId: uuidv7(), changedSectionCount: 1 },
        });
        logger.info("run.completed", {
          runId: id,
          durationMs: clock.now() - started,
          chunkCount: stats.chunksSent,
          stepCount: 1,
        });

        if (ctx.attempt.number === 1 && id === runId) {
          // A provider failure whose message and body quote the prompt is mapped before it is thrown.
          const providerError = Object.assign(new Error(`400: invalid request for "${message}"`), {
            name: "AI_APICallError",
            requestBodyValues: { prompt: message },
            responseBody: section,
          });
          throw toWorkerError(providerError);
        }
        return { runId: id, steps: 1, chunksSent: stats.chunksSent };
      },
      { maxAttempts: 1 },
    );

    const handle = await trigger.tasks.trigger("simon-run", { runId }, { idempotencyKey: runId });
    await trigger.runUntilIdle();
    const failed = await trigger.runs.retrieve(handle.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatchObject({ name: "WorkerError", message: "ai.unavailable" });

    // A second, successful turn exercises the output sink.
    const second = uuidv7();
    store.set(second, { ...(store.get(runId) as StoredRun) });
    const secondHandle = await trigger.tasks.trigger(
      "simon-run",
      { runId: second },
      { idempotencyKey: second, tags: [`run:${second}`] },
    );
    await trigger.runUntilIdle();
    expect((await trigger.runs.retrieve(secondHandle.id)).output).toEqual({
      runId: second,
      steps: 1,
      chunksSent: 8,
    });

    // Nothing Trigger-hosted holds the marker.
    expect(trigger.findMarker(MARKER)).toEqual([]);
    expect(findMarkerIn(trigger.errors, MARKER)).toEqual([]);
    expect(trigger.logs.length).toBeGreaterThan(0);

    // The api received signed requests; the marker is only inside decryptable envelopes.
    expect(apiBodies.length).toBeGreaterThan(0);
    expect(apiBodies.every((entry) => entry.verified)).toBe(true);
    expect(apiBodies.filter((entry) => entry.body.includes(MARKER))).toEqual([]);
    const decrypted = apiBodies
      .filter((entry) => entry.path.endsWith("/output"))
      .map((entry) => {
        const body = runOutputBodySchema.parse(JSON.parse(entry.body.toString("utf8")));
        return decryptFieldText(
          accountKey,
          runChunkContext(ownerId, body.runId, body.seq),
          body.envelope,
        );
      })
      .join("\n");
    expect(decrypted).toContain(MARKER);
  });
});
