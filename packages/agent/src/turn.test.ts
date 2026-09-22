import { SimonRepository, SimonUserAsks } from "@symplist/core/simon";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../../core/src/documents/test-support.ts";
import { type SimonModel, SimonModelError } from "./providers.ts";
import { SIMON_RULES_VERSION } from "./rules.ts";
import {
  boundSimonHistory,
  runSimonTurn,
  SIMON_MAX_HISTORY_BYTES,
  SIMON_MAX_HISTORY_MESSAGES,
  type SimonTurnDependencies,
} from "./turn.ts";

let env: DocumentsTestEnvironment;
let repository: SimonRepository;
let owner: string;
let conversation: string;
type Chunk =
  Awaited<ReturnType<SimonModel["doStream"]>>["stream"] extends ReadableStream<infer T> ? T : never;
function answer(text: string) {
  return scripted([
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: text },
    { type: "text-end", id: "text" },
  ]);
}
function scripted(chunks: Chunk[], finish: "stop" | "tool-calls" = "stop") {
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
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
  };
}
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  repository = new SimonRepository({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: 24,
  });
  await env.db.run({ sql: "UPDATE executor_state SET mode = 'local'", params: [] });
  owner = await env.createUser();
  conversation = await repository.createConversation(owner, null);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.close();
});
async function submit(text = "private user marker", request = "message") {
  const accepted = await repository.acceptMessage(owner, conversation, request, {
    text,
    tier: "fast",
  });
  if (!accepted.runId) throw new Error("expected accepted run");
  return accepted.runId;
}
function dependencies(model: SimonModel): SimonTurnDependencies {
  return {
    repository,
    executor: "local",
    signal: new AbortController().signal,
    telemetryEnabled: true,
    models: {
      resolve: vi.fn(() => ({ provider: "scripted" as const, modelId: model.modelId, model })),
    },
    log: vi.fn(),
    sink: vi.fn(() => ({
      write: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    })),
  };
}

describe("Simon model history bounds", () => {
  const row = (seq: number, text: string, snapshotJson: string | null = null) => ({
    id: `message-${seq}`,
    seq,
    role: "user" as const,
    text,
    snapshotJson,
  });

  it("retains only the newest forty messages and exposes the real retained floor", () => {
    const history = Array.from({ length: SIMON_MAX_HISTORY_MESSAGES + 5 }, (_, index) =>
      row(index + 1, `message ${index + 1}`),
    );
    const bounded = boundSimonHistory(history);
    expect(bounded.rows).toHaveLength(SIMON_MAX_HISTORY_MESSAGES);
    expect(bounded.rows[0]?.seq).toBe(6);
    expect(bounded.rows.at(-1)?.seq).toBe(45);
    expect(bounded.floorSeq).toBe(6);
  });

  it("uses encrypted snapshot size for the sixty-four KiB model-context ceiling", () => {
    const bounded = boundSimonHistory([
      row(1, "small", JSON.stringify({ value: "a".repeat(SIMON_MAX_HISTORY_BYTES / 2) })),
      row(2, "small", JSON.stringify({ value: "b".repeat(SIMON_MAX_HISTORY_BYTES / 2) })),
      row(3, "current"),
    ]);
    expect(bounded.rows.map(({ seq }) => seq)).toEqual([2, 3]);
    expect(bounded.floorSeq).toBe(2);
  });

  it("always retains the current message even when that message alone exceeds the byte ceiling", () => {
    const bounded = boundSimonHistory([
      row(1, "older"),
      row(2, "x".repeat(SIMON_MAX_HISTORY_BYTES + 1)),
    ]);
    expect(bounded.rows.map(({ seq }) => seq)).toEqual([2]);
    expect(bounded.floorSeq).toBe(2);
  });
});

describe("claimed Simon turn integration", () => {
  describe.each(["local", "trigger"] as const)("stable provider outcomes under %s", (executor) => {
    it.each(["ai.unavailable", "ai.provider_failed"] as const)(
      "persists %s without provider details on a rejected setup",
      async (code) => {
        await env.db.run({
          sql: "UPDATE executor_state SET mode=?",
          params: [executor === "local" ? "local" : "durable"],
        });
        const runId = await submit();
        const deps = { ...dependencies(new MockLanguageModelV4()), executor };
        deps.models.resolve = () => {
          if (code === "ai.unavailable") throw new SimonModelError("ai.unavailable");
          throw Object.assign(new Error("PRIVATE-PROVIDER-ERROR-MARKER"), {
            code: "provider.private_secret",
          });
        };
        const error = await runSimonTurn(runId, deps).catch((value: unknown) => value);
        expect(error).toMatchObject({ code, message: code });
        expect(error).not.toHaveProperty("cause");
        expect(
          await env.db.first({
            sql: "SELECT status,outcome_code FROM runs WHERE id=?",
            params: [runId],
          }),
        ).toEqual({ status: "interrupted", outcome_code: code });
        expect(JSON.stringify(error)).not.toContain("PRIVATE-PROVIDER-ERROR-MARKER");
        expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toContain(
          "PRIVATE-PROVIDER-ERROR-MARKER",
        );
      },
    );

    it("persists a terminal stream failure in its checkpoint and preserves Stop precedence", async () => {
      await env.db.run({
        sql: "UPDATE executor_state SET mode=?",
        params: [executor === "local" ? "local" : "durable"],
      });
      const runId = await submit();
      const model = new MockLanguageModelV4({
        doStream: scripted([{ type: "error", error: new Error("PRIVATE-STREAM-ERROR-MARKER") }]),
      });
      const deps = { ...dependencies(model), executor };
      expect((await runSimonTurn(runId, deps)).status).toBe("failed");
      expect(
        await env.db.first({
          sql: "SELECT status,outcome_code FROM runs WHERE id=?",
          params: [runId],
        }),
      ).toEqual({ status: "failed", outcome_code: "ai.provider_failed" });
      expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toContain(
        "PRIVATE-STREAM-ERROR-MARKER",
      );
      const stopped = await submit("Stop before provider failure", "stop-precedence");
      const stoppedDeps = { ...dependencies(new MockLanguageModelV4()), executor };
      // Cancellation is injected at the next awaited history read.
      const read = repository.executionHistory.bind(repository);
      vi.spyOn(repository, "executionHistory").mockImplementationOnce(async (run, key) => {
        await repository.stop(owner, run.id);
        return read(run, key);
      });
      await runSimonTurn(stopped, stoppedDeps).catch(() => {});
      expect(
        await env.db.first({
          sql: "SELECT status,outcome_code FROM runs WHERE id=?",
          params: [stopped],
        }),
      ).toEqual({ status: "stopped", outcome_code: "stopped" });
    });
  });
  it.each(["local", "trigger"] as const)(
    "runs the same encrypted history and checkpoint contract under %s",
    async (executor) => {
      await env.db.run({
        sql: "UPDATE executor_state SET mode = ?",
        params: [executor === "trigger" ? "durable" : "local"],
      });
      const runId = await submit();
      const model = new MockLanguageModelV4({ doStream: answer("private assistant marker") });
      const deps = { ...dependencies(model), executor };
      const release = vi.spyOn(repository, "releaseClaim");
      expect(await runSimonTurn(runId, deps)).toEqual({ status: "completed", steps: 1 });
      expect(await repository.run(owner, runId)).toMatchObject({ status: "completed", executor });
      const parts = await env.db.all({ sql: "SELECT * FROM message_parts", params: [] });
      expect(parts).toHaveLength(1);
      expect(parts[0]?.content_enc).toMatch(/^sym1\./);
      expect(JSON.stringify(parts)).not.toContain("private assistant marker");
      expect(release).toHaveBeenCalledTimes(1);
      expect(release.mock.calls[0]?.[0].key.key.every((value) => value === 0)).toBe(true);
      expect(
        await env.db.first({
          sql: "SELECT input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, provider, rules_version FROM runs WHERE id = ?",
          params: [runId],
        }),
      ).toMatchObject({
        input_tokens: 4,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 2,
        provider: "scripted",
        rules_version: SIMON_RULES_VERSION,
      });
    },
  );
  it("a duplicate delivery never constructs a model, tool or output sink", async () => {
    const runId = await submit();
    const deps = dependencies(new MockLanguageModelV4({ doStream: answer("done") }));
    await runSimonTurn(runId, deps);
    vi.mocked(deps.models.resolve).mockClear();
    vi.mocked(deps.sink).mockClear();
    const tools = vi.fn(async () => ({}));
    expect(await runSimonTurn(runId, { ...deps, tools })).toEqual({ status: "noop", steps: 0 });
    expect(deps.models.resolve).not.toHaveBeenCalled();
    expect(deps.sink).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
  });
  it.each(["local", "trigger"] as const)(
    "refuses relocked accounts and the wrong executor before provider or tool work under %s",
    async (executor) => {
      await env.db.run({
        sql: "UPDATE executor_state SET mode=?",
        params: [executor === "local" ? "local" : "durable"],
      });
      const runId = await submit();
      const tools = vi.fn(async () => ({}));
      const deps = {
        ...dependencies(new MockLanguageModelV4({ doStream: answer("no") })),
        executor,
        tools,
      };
      const other = executor === "local" ? "trigger" : "local";
      expect((await runSimonTurn(runId, { ...deps, executor: other })).status).toBe("noop");
      await env.relock(owner);
      expect((await runSimonTurn(runId, deps)).status).toBe("noop");
      expect(deps.models.resolve).not.toHaveBeenCalled();
      expect(deps.sink).not.toHaveBeenCalled();
      expect(tools).not.toHaveBeenCalled();
    },
  );
  it("excludes queued messages until their turn and places them after the preceding reply", async () => {
    const runId = await submit("first user marker");
    await repository.acceptMessage(owner, conversation, "second", {
      text: "queued user marker",
      tier: "fast",
    });
    const first = new MockLanguageModelV4({ doStream: answer("first assistant marker") });
    await runSimonTurn(runId, dependencies(first));
    expect(JSON.stringify(first.doStreamCalls[0]?.prompt)).not.toContain("queued user marker");
    const next = await env.db.first({
      sql: "SELECT active_run_id FROM conversations WHERE id = ?",
      params: [conversation],
    });
    const second = new MockLanguageModelV4({ doStream: answer("second assistant") });
    await runSimonTurn(String(next?.active_run_id), dependencies(second));
    const prompt = JSON.stringify(second.doStreamCalls[0]?.prompt);
    expect(prompt.indexOf("first user marker")).toBeLessThan(
      prompt.indexOf("first assistant marker"),
    );
    expect(prompt.indexOf("first assistant marker")).toBeLessThan(
      prompt.indexOf("queued user marker"),
    );
    expect((await repository.history(owner, conversation)).map((m) => m.text)).toEqual([
      "first user marker",
      "first assistant marker",
      "queued user marker",
      "second assistant",
    ]);
  });
  it("commits an ask and its complete tool part before showing its card, then continues with the answer", async () => {
    const runId = await submit();
    const asking = new MockLanguageModelV4({
      doStream: scripted(
        [
          {
            type: "tool-call",
            toolCallId: "ask-call",
            toolName: "user_ask",
            input: JSON.stringify({ question: "Which section?" }),
          },
        ],
        "tool-calls",
      ),
    });
    const deps = dependencies(asking);
    let askId = "";
    let cards = 0;
    const sink = deps.sink;
    await runSimonTurn(runId, {
      ...deps,
      sink: (claim) => {
        const output = sink(claim);
        return {
          ...output,
          write: async (chunk) => {
            if (chunk.type === "tool-output-available") {
              const value = chunk.output as { askId: string };
              askId = value.askId;
              cards += 1;
              expect((await new SimonUserAsks(repository).load(owner, askId)).question).toBe(
                "Which section?",
              );
              expect((await repository.run(owner, runId))?.status).toBe("awaiting_user");
              expect(await env.count("message_parts")).toBe(1);
            }
          },
        };
      },
    });
    expect(cards).toBe(1);
    const next = await new SimonUserAsks(repository).decide(owner, askId, {
      kind: "answer",
      text: "The introduction",
    });
    const continuing = new MockLanguageModelV4({ doStream: answer("I'll read that section") });
    expect((await runSimonTurn(next, dependencies(continuing))).status).toBe("completed");
    expect(JSON.stringify(continuing.doStreamCalls[0]?.prompt)).toContain("The introduction");
    expect(JSON.stringify(continuing.doStreamCalls[0]?.prompt)).not.toContain("awaiting_user");
    expect(await env.count("user_asks")).toBe(1);
  });
  it("keeps arbitrary provider and storage exception content outside task errors", async () => {
    const runId = await submit();
    const deps = dependencies(new MockLanguageModelV4());
    deps.models.resolve = () => {
      throw new Error("private raw provider marker");
    };
    const error = await runSimonTurn(runId, deps).catch((value: unknown) => value);
    expect(error).toMatchObject({ message: "ai.provider_failed" });
    expect(error).not.toHaveProperty("cause");
    expect((await repository.run(owner, runId))?.status).toBe("interrupted");
    expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toContain(
      "private raw provider marker",
    );
  });
});
