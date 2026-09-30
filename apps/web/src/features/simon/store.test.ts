import { describe, expect, it, vi } from "vitest";
import { ChatStore, canCancelChat, canSendChat, describeFailure } from "./store.ts";
import { fakeChatBridge, fakePermission, messageUpdate, toolCallUpdate } from "./test-support.ts";

/*
 * The store carries the two invariants of this transport, and neither shows up in a happy-path test:
 * ACP admits exactly one prompt per session, and a cancel that does not answer an outstanding
 * `session/request_permission` leaves the harness parked on a question forever. Both are pinned below.
 */
const cwd = "/Users/someone/projects/symplist";

async function opened(bridge = fakeChatBridge()) {
  const store = new ChatStore(bridge);
  const release = store.watch("task-1");
  await store.open("task-1", { cwd });
  return { store, bridge, release };
}

describe("opening a conversation", () => {
  it("replays the stored transcript through the same reducer the live pane uses", async () => {
    const bridge = fakeChatBridge({
      history: {
        updates: [
          { seq: 1, receivedAt: 1, update: messageUpdate("m1", "Earlier answer.") },
          { seq: 2, receivedAt: 2, update: toolCallUpdate("c1", "bash", { command: "ls" }) },
        ],
        nextBeforeSeq: null,
      },
    });
    const { store } = await opened(bridge);
    const state = store.get("task-1");
    expect(state.phase).toBe("idle");
    expect(state.cwd).toBe(cwd);
    expect(state.projection.items.map((item) => item.kind)).toEqual(["assistant", "tool"]);
  });

  it("marks the point the agent's memory was lost when its session could not be resumed", async () => {
    // We own the transcript; dsh owns the model context, and ACP has no transcript replay. So a session
    // that has gone leaves our history intact and the agent's memory of it empty, and the pane must say
    // so rather than let the person find out by being misunderstood.
    const bridge = fakeChatBridge({
      memoryReset: true,
      history: {
        updates: [{ seq: 1, receivedAt: 1, update: messageUpdate("m1", "From last week.") }],
        nextBeforeSeq: null,
      },
    });
    const { store } = await opened(bridge);
    expect(store.get("task-1").projection.memoryResetAfter).toBe(1);
  });

  it("stays in setup and reports the failure when the session cannot be started", async () => {
    const bridge = fakeChatBridge({ startError: new Error("The assistant is not running.") });
    const { store } = await opened(bridge);
    expect(store.get("task-1").phase).toBe("setup");
    expect(store.get("task-1").failure?.message).toBe("The assistant is not running.");
  });

  it("prepends an older page without re-reading the newer one", async () => {
    const bridge = fakeChatBridge({
      history: {
        updates: [{ seq: 9, receivedAt: 9, update: messageUpdate("m9", "newest") }],
        nextBeforeSeq: 9,
      },
    });
    const { store } = await opened(bridge);
    bridge.history = vi.fn(async () => ({
      updates: [{ seq: 1, receivedAt: 1, update: messageUpdate("m1", "oldest") }],
      nextBeforeSeq: null,
    }));
    await store.loadOlder("task-1");
    const state = store.get("task-1");
    expect(state.projection.items.map((item) => "text" in item && item.text)).toEqual([
      "oldest",
      "newest",
    ]);
    expect(state.nextBeforeSeq).toBeNull();
  });
});

describe("one prompt in flight", () => {
  it("disables send the instant a prompt is sent, not when the call resolves", async () => {
    const { store, bridge } = await opened();
    store.draft("task-1", "Do the tests pass?");
    expect(canSendChat(store.get("task-1"))).toBe(true);
    const sending = store.send("task-1");
    // Already refused, before the await: a second press must not land a second prompt on a session that
    // admits exactly one.
    expect(canSendChat(store.get("task-1"))).toBe(false);
    store.draft("task-1", "and again");
    await store.send("task-1");
    await sending;
    expect(bridge.calls.prompts).toEqual([
      { conversationId: "conv-1", text: "Do the tests pass?" },
    ]);
  });

  it("adds the person's own message locally, because the harness never echoes a prompt back", async () => {
    const { store } = await opened();
    store.draft("task-1", "  Run the suite  ");
    await store.send("task-1");
    expect(store.get("task-1").projection.items).toEqual([
      { kind: "user", id: "local:1", text: "Run the suite" },
    ]);
    expect(store.get("task-1").draft).toBe("");
  });

  it("releases the composer when the prompt is refused outright", async () => {
    const bridge = fakeChatBridge({ promptError: new Error("Add a model key to continue.") });
    const { store } = await opened(bridge);
    store.draft("task-1", "hello");
    await store.send("task-1");
    const state = store.get("task-1");
    // Nothing will send a `turn_ended` for a turn that never started, so the phase has to be let go here
    // or the pane would be stuck working forever.
    expect(state.phase).toBe("idle");
    expect(state.failure?.message).toBe("Add a model key to continue.");
  });

  it("refuses an empty or whitespace-only draft", async () => {
    const { store } = await opened();
    store.draft("task-1", "   ");
    expect(canSendChat(store.get("task-1"))).toBe(false);
    await store.send("task-1");
    expect(store.get("task-1").projection.items).toEqual([]);
  });
});

describe("cancelling", () => {
  it("answers an outstanding permission with cancelled before it cancels the turn", async () => {
    const { store, bridge } = await opened();
    store.draft("task-1", "delete everything");
    await store.send("task-1");
    bridge.emit("conv-1", { type: "permission", request: fakePermission("c1", "req-7") });
    expect(store.get("task-1").phase).toBe("awaiting_permission");
    await store.cancel("task-1");
    // The order is the point. `session/cancel` does not resolve a permission the harness is already
    // blocked on, so answering second — or not at all — parks the agent with no error and no log.
    expect(bridge.calls.permissions).toEqual([{ requestId: "req-7", optionId: "cancelled" }]);
    expect(bridge.calls.cancels).toEqual(["conv-1"]);
    expect(store.get("task-1").projection.pendingPermission).toBeNull();
  });

  it("cancels a turn that is not waiting on anything", async () => {
    const { store, bridge } = await opened();
    store.draft("task-1", "keep going");
    await store.send("task-1");
    await store.cancel("task-1");
    expect(bridge.calls.permissions).toEqual([]);
    expect(bridge.calls.cancels).toEqual(["conv-1"]);
  });

  it("does not ask twice, and does nothing when there is no turn", async () => {
    const { store, bridge } = await opened();
    expect(canCancelChat(store.get("task-1"))).toBe(false);
    await store.cancel("task-1");
    store.draft("task-1", "go");
    await store.send("task-1");
    await store.cancel("task-1");
    expect(canCancelChat(store.get("task-1"))).toBe(false);
    await store.cancel("task-1");
    expect(bridge.calls.cancels).toEqual(["conv-1"]);
  });
});

describe("live events", () => {
  it("follows a turn from working through a permission and back to idle", async () => {
    const { store, bridge } = await opened();
    store.draft("task-1", "run it");
    await store.send("task-1");
    expect(store.get("task-1").phase).toBe("working");
    bridge.emitUpdate("conv-1", toolCallUpdate("c1", "bash", { command: "ls" }));
    bridge.emit("conv-1", { type: "permission", request: fakePermission("c1") });
    expect(store.get("task-1").phase).toBe("awaiting_permission");
    bridge.emit("conv-1", { type: "permission_settled", requestId: "req-1" });
    expect(store.get("task-1").phase).toBe("working");
    bridge.emitUpdate("conv-1", messageUpdate("m1", "Nothing to report."));
    bridge.emit("conv-1", { type: "turn_ended", stopReason: "end_turn" });
    const state = store.get("task-1");
    expect(state.phase).toBe("idle");
    expect(state.projection.stopReason).toBe("end_turn");
    expect(state.projection.items.map((item) => item.kind)).toEqual(["user", "tool", "assistant"]);
  });

  it("answers a permission and reports the choice, then keeps working", async () => {
    const { store, bridge } = await opened();
    store.draft("task-1", "run it");
    await store.send("task-1");
    bridge.emit("conv-1", { type: "permission", request: fakePermission("c1", "req-2") });
    await store.answerPermission("task-1", "allow-once");
    expect(bridge.calls.permissions).toEqual([{ requestId: "req-2", optionId: "allow-once" }]);
    expect(store.get("task-1").phase).toBe("working");
    expect(store.get("task-1").projection.pendingPermission).toBeNull();
  });

  it("keeps the subscription while any view holds it", async () => {
    const bridge = fakeChatBridge();
    const store = new ChatStore(bridge);
    const first = store.watch("task-1");
    await store.open("task-1", { cwd });
    const second = store.watch("task-1");
    first();
    bridge.emitUpdate("conv-1", messageUpdate("m1", "still listening"));
    expect(store.get("task-1").projection.items).toHaveLength(1);
    second();
    bridge.emitUpdate("conv-1", messageUpdate("m2", "gone"));
    expect(store.get("task-1").projection.items).toHaveLength(1);
  });

  it("keeps a task's conversation apart from the workspace-wide one", async () => {
    const bridge = fakeChatBridge();
    const store = new ChatStore(bridge);
    store.watch("task-1");
    await store.open("task-1", { cwd });
    store.draft("task-1", "about this task");
    store.draft(null, "about anything");
    expect(store.get("task-1").draft).toBe("about this task");
    expect(store.get(null).draft).toBe("about anything");
    expect(store.get(null).phase).toBe("setup");
  });

  it("notifies subscribers so the pane re-renders", async () => {
    const { store, bridge } = await opened();
    const listener = vi.fn();
    store.subscribe(listener);
    bridge.emitUpdate("conv-1", messageUpdate("m1", "hello"));
    expect(listener).toHaveBeenCalled();
  });

  it("stops listening on dispose", async () => {
    const { store, bridge } = await opened();
    store.dispose();
    bridge.emitUpdate("conv-1", messageUpdate("m1", "after dispose"));
    expect(store.get("task-1").projection.items).toEqual([]);
  });
});

describe("session options and failures", () => {
  it("passes a model choice to the harness for the next turn", async () => {
    const { store, bridge } = await opened();
    await store.setConfig("task-1", "model", '["deepseek-official","deepseek-v4-pro"]');
    expect(bridge.calls.configs).toEqual([
      { id: "model", value: '["deepseek-official","deepseek-v4-pro"]' },
    ]);
  });

  it("reports a failure with its code and lets the person dismiss it", async () => {
    const { store } = await opened();
    const failing = new Error("Simon lost its connection to the harness.");
    (failing as { code?: string }).code = "chat.harness_gone";
    expect(describeFailure(failing)).toEqual({
      code: "chat.harness_gone",
      message: "Simon lost its connection to the harness.",
    });
    expect(describeFailure("not an error")).toEqual({
      code: "chat.failed",
      message: "Simon could not complete that.",
    });
    store.dismissFailure("task-1");
    expect(store.get("task-1").failure).toBeNull();
  });
});
