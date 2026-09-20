import { simonConversationViewSchema } from "@symplist/contracts";
import { describe, expect, it } from "vitest";
import { emptyProjection, projectEvent, projectedMessages, projectSnapshot } from "./projection.ts";

const conversationId = "01995000-0000-7000-8000-000000000001";
const runId = "01995000-0000-7000-8000-000000000002";
const messageId = "01995000-0000-7000-8000-000000000003";
const view = simonConversationViewSchema.parse({
  conversationId,
  kind: "quick",
  taskId: null,
  activeRun: {
    runId,
    conversationId,
    taskId: null,
    status: "running",
    tier: "fast",
    stopRequested: false,
  },
  pendingApprovalId: null,
  pendingAskId: null,
  messages: [],
  nextBeforeSeq: null,
});
const chunk = (seq: number, data: object) => ({ seq, type: "chunk", data: { runId, chunk: data } });
const start = chunk(1, { type: "start" });
const textStart = chunk(2, { type: "text-start", id: "text-one" });
const delta = chunk(3, { type: "text-delta", id: "text-one", delta: "Hello" });
function streamed() {
  return [start, textStart, delta].reduce(projectEvent, { ...emptyProjection, view });
}

describe("Simon live projection", () => {
  it("deduplicates replayed chunks by topic sequence", () => {
    const first = streamed();
    expect(projectEvent(first, delta)).toBe(first);
    expect(projectedMessages(first)).toMatchObject([{ text: "Hello", runId }]);
  });
  it("replaces a saved checkpoint for the same run instead of appending it", () => {
    const state = streamed();
    const saved = {
      ...view,
      messages: [
        {
          id: messageId,
          seq: 2,
          role: "assistant" as const,
          runId,
          text: "Hel",
          parts: [{ type: "text" as const, text: "Hel" }],
          status: "accepted" as const,
        },
      ],
    };
    const messages = projectedMessages({ ...state, view: saved });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: messageId, text: "Hello" });
  });
  it("rebuilds the complete live tail on snapshot without doubling text", () => {
    const snapshot = projectSnapshot(streamed(), conversationId, 3, {
      ...view,
      live: [start, textStart, delta],
      liveTruncated: false,
    });
    expect(projectedMessages(snapshot)[0]?.text).toBe("Hello");
    expect(projectedMessages(projectEvent(snapshot, delta))[0]?.text).toBe("Hello");
  });
  it("uses saved text when the bounded live tail lacks the start", () => {
    const saved = {
      ...view,
      messages: [
        {
          id: messageId,
          seq: 1,
          role: "assistant",
          runId,
          text: "Saved checkpoint",
          parts: [],
          status: "accepted",
        },
      ],
    };
    const snapshot = projectSnapshot(streamed(), conversationId, 3, {
      ...saved,
      live: [delta],
      liveTruncated: true,
    });
    expect(snapshot.live).toBeNull();
    expect(projectedMessages(snapshot)[0]?.text).toBe("Saved checkpoint");
  });
  it("ignores old-run output and output after finish", () => {
    const state = streamed();
    const other = projectEvent(state, {
      ...chunk(4, { type: "text-delta", id: "text-one", delta: "Foreign" }),
      data: { runId: messageId, chunk: { type: "start" } },
    });
    expect(other.live).toBe(state.live);
    const finished = projectEvent(state, chunk(4, { type: "finish" }));
    expect(
      projectedMessages(
        projectEvent(finished, chunk(5, { type: "text-delta", id: "text-one", delta: "Late" })),
      )[0]?.text,
    ).toBe("Hello");
  });
  it("never retains tool arguments/results, metadata or hidden reasoning", () => {
    let state = streamed();
    state = projectEvent(
      state,
      chunk(4, {
        type: "tool-input-available",
        toolCallId: "tool",
        toolName: "task_context",
        input: { secret: "private-marker" },
      }),
    );
    state = projectEvent(
      state,
      chunk(5, { type: "tool-output-available", toolCallId: "tool", output: "private-marker" }),
    );
    state = projectEvent(
      state,
      chunk(6, { type: "reasoning-delta", id: "private-marker", delta: "private-marker" }),
    );
    state = projectEvent(
      state,
      chunk(7, { type: "message-metadata", messageMetadata: "private-marker" }),
    );
    expect(JSON.stringify(projectedMessages(state))).not.toContain("private-marker");
    expect(projectedMessages(state)[0]?.parts).toContainEqual({
      type: "tool",
      toolCallId: "tool",
      toolName: "task_context",
      state: "output-available",
    });
  });
  it("does not accept another conversation's snapshot or malformed history", () => {
    const state = streamed();
    expect(projectSnapshot(state, conversationId, 9, { ...view, conversationId: messageId })).toBe(
      state,
    );
    expect(projectSnapshot(state, conversationId, 9, { ...view, messages: "bad" })).toBe(state);
  });
  it("bounds accumulated live text without losing the saved transcript", () => {
    const state = streamed();
    const oversized = projectEvent(
      state,
      chunk(4, { type: "text-delta", id: "text-one", delta: "a".repeat(262144) }),
    );
    expect(oversized.live).toBe(state.live);
  });
});
