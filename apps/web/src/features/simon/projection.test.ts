import { describe, expect, it } from "vitest";
import {
  type ChatEvent,
  type ChatToolCall,
  emptyChatProjection,
  permissionSubject,
  reduceChat,
  replayChat,
  selectOption,
  workingLine,
} from "./projection.ts";

/*
 * The reducer is the only thing that turns ACP into a transcript, and it runs twice over the same rows:
 * once as they arrive and once when a stored conversation is replayed. So the tests that matter are the
 * ones that pin "live and replayed agree" and the ones that pin what a partial `tool_call_update` may
 * not destroy.
 *
 * Every fixture is the shape `dsh-acp` emits, read off its build: `tool_call` carries the tool's
 * programmatic name in `title` with a hardcoded `kind: "other"`, `tool_call_update` carries only
 * `status` and `content`, and a permission request names nothing but a `toolCallId`.
 */
const turn: readonly ChatEvent[] = [
  { type: "user", id: "u1", text: "Do the tests pass?" },
  {
    type: "update",
    update: {
      sessionUpdate: "agent_thought_chunk",
      messageId: "m1",
      content: { type: "text", text: "I should run the suite" },
    },
  },
  {
    type: "update",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "bash",
      kind: "other",
      status: "in_progress",
      rawInput: { command: "pnpm test" },
    },
  },
  {
    type: "permission",
    request: {
      requestId: "r1",
      sessionId: "s1",
      toolCall: { toolCallId: "c1" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  },
  { type: "permission_settled" },
  {
    type: "update",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "12 passed" } }],
    },
  },
  {
    type: "update",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "m2",
      content: { type: "text", text: "They pass — " },
    },
  },
  {
    type: "update",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "m2",
      content: { type: "text", text: "twelve of them." },
    },
  },
  { type: "update", update: { sessionUpdate: "usage_update", used: 4_100, size: 128_000 } },
  { type: "turn_ended", stopReason: "end_turn" },
];

const tool = (state: ReturnType<typeof replayChat>, id: string): ChatToolCall => {
  const found = state.items.find((item) => item.kind === "tool" && item.toolCallId === id);
  if (found?.kind !== "tool") throw new Error(`no tool call ${id}`);
  return found;
};

describe("chat projection", () => {
  it("folds a whole turn into a readable transcript", () => {
    const state = replayChat(turn);
    expect(state.items.map((item) => item.kind)).toEqual(["user", "thought", "tool", "assistant"]);
    expect(state.items[3]).toMatchObject({
      kind: "assistant",
      text: "They pass — twelve of them.",
    });
    expect(tool(state, "c1")).toMatchObject({
      name: "bash",
      status: "completed",
      toolKind: "other",
    });
    expect(state.usage).toEqual({ used: 4_100, size: 128_000 });
    expect(state.stopReason).toBe("end_turn");
    expect(state.pendingPermission).toBeNull();
  });

  it("replays a stored transcript to exactly what the live fold produced", () => {
    // This is the whole reason the wire format is what gets persisted. If these two ever differ, history
    // and the live pane are drawing from different truths and a projection bug needs fixing twice.
    const live = turn.reduce(reduceChat, emptyChatProjection);
    expect(replayChat(turn)).toEqual(live);
  });

  it("starts a new bubble on a new messageId and appends on the same one", () => {
    const state = replayChat([
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "a",
          content: { type: "text", text: "one" },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "a",
          content: { type: "text", text: " two" },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "b",
          content: { type: "text", text: "three" },
        },
      },
    ]);
    expect(state.items).toEqual([
      { kind: "assistant", messageId: "a", text: "one two" },
      { kind: "assistant", messageId: "b", text: "three" },
    ]);
  });

  it("keeps thoughts out of the prose even when they share a messageId with it", () => {
    const state = replayChat([
      {
        type: "update",
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "m",
          content: { type: "text", text: "weighing it up" },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m",
          content: { type: "text", text: "Here is the answer." },
        },
      },
    ]);
    expect(state.items.map((item) => item.kind)).toEqual(["thought", "assistant"]);
  });

  it("does not let a status-only update wipe the content an earlier one delivered", () => {
    const state = replayChat([
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "bash",
          rawInput: { command: "ls" },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          content: [{ type: "content", content: { type: "text", text: "a.md" } }],
        },
      },
      {
        type: "update",
        update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
      },
    ]);
    const call = tool(state, "c1");
    expect(call.status).toBe("completed");
    expect(call.content).toHaveLength(1);
    expect(call.rawInput).toEqual({ command: "ls" });
  });

  it("treats explicit null as 'unchanged', the way ACP defines it", () => {
    const state = replayChat([
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "bash" } },
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          title: null,
          kind: null,
          status: "failed",
          content: null,
          locations: null,
        },
      },
    ]);
    expect(tool(state, "c1")).toMatchObject({ name: "bash", toolKind: "other", status: "failed" });
  });

  it("ignores an update for a tool call it never saw start", () => {
    const state = replayChat([
      {
        type: "update",
        update: { sessionUpdate: "tool_call_update", toolCallId: "ghost", status: "completed" },
      },
    ]);
    expect(state.items).toEqual([]);
  });

  it("ignores an update kind it does not know rather than losing the transcript", () => {
    const state = replayChat([
      { type: "user", id: "u1", text: "hello" },
      { type: "update", update: { sessionUpdate: "plan", entries: [{ content: "x" }] } },
      { type: "update", update: { sessionUpdate: "compaction_update", compactionId: "k" } },
      { type: "update", update: "not even an object" },
    ]);
    expect(state.items).toEqual([{ kind: "user", id: "u1", text: "hello" }]);
  });

  it("clears the permission gate when the turn ends, so no card outlives its answer", () => {
    // A card left on screen after the harness stopped waiting invites an answer that cannot be
    // delivered, and the person is owed the truth that the moment has passed.
    const state = replayChat([
      {
        type: "permission",
        request: {
          requestId: "r1",
          sessionId: "s1",
          toolCall: { toolCallId: "c1" },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        },
      },
      { type: "turn_ended", stopReason: "cancelled" },
    ]);
    expect(state.pendingPermission).toBeNull();
    expect(state.stopReason).toBe("cancelled");
  });

  it("finds the tool call a permission request is about, because the request itself names only an id", () => {
    const state = replayChat(turn.slice(0, 4));
    expect(permissionSubject(state)).toMatchObject({
      name: "bash",
      rawInput: { command: "pnpm test" },
    });
    expect(permissionSubject(emptyChatProjection)).toBeNull();
  });

  it("marks where the agent's memory was lost without touching the transcript above it", () => {
    const state = replayChat([...turn, { type: "memory_reset" }]);
    expect(state.memoryResetAfter).toBe(4);
    expect(state.items).toHaveLength(4);
  });

  it("clears the stop reason when a new turn starts", () => {
    const state = replayChat([...turn, { type: "turn_started" }]);
    expect(state.stopReason).toBeNull();
  });
});

describe("the working strip", () => {
  it("prefers the newest running tool call, because that is the only real progress signal", () => {
    const state = replayChat(turn.slice(0, 3));
    expect(workingLine(state)).toEqual({ kind: "tool", text: "bash" });
  });

  it("falls back to the last line of reasoning once every tool call has settled", () => {
    const state = replayChat([
      {
        type: "update",
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "m1",
          content: { type: "text", text: "first\nsecond line" },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "bash",
          status: "completed",
        },
      },
    ]);
    expect(workingLine(state)).toEqual({ kind: "thought", text: "second line" });
  });

  it("says nothing when there is nothing to report, and lets the caller word that", () => {
    expect(workingLine(emptyChatProjection)).toBeNull();
    expect(workingLine(replayChat([{ type: "user", id: "u1", text: "hi" }]))).toBeNull();
  });
});

describe("session configuration", () => {
  it("hands back the advertised select option the model picker is built from", () => {
    const state = replayChat([
      {
        type: "update",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "route-a",
              options: [
                { value: "route-a", name: "Route A" },
                { value: "route-b", name: "Route B" },
              ],
            },
            { id: "verbose", name: "Verbose", type: "boolean", currentValue: false },
          ],
        },
      },
    ]);
    expect(selectOption(state, "model")).toMatchObject({ currentValue: "route-a" });
    expect(selectOption(state, "verbose")).toBeNull();
    expect(selectOption(state, "absent")).toBeNull();
  });
});
