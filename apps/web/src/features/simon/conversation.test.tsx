import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPane } from "./chat-pane.tsx";
import { SimonProvider } from "./provider.tsx";
import {
  type FakeChatBridge,
  fakeChatBridge,
  fakePermission,
  messageUpdate,
  toolCallUpdate,
} from "./test-support.ts";

/*
 * The whole pane, driven the way main drives it: the folder is chosen, a prompt is sent, tool calls and a
 * permission request arrive over the fake bridge, and the turn ends. The thesis of the desktop app is a
 * turn that runs a command and edits a document section, so that turn is the test that matters most.
 *
 * `use-stick-to-bottom` measures a scroll container, which jsdom does not have, so the two observers it
 * reaches for are stubbed once here rather than in each test.
 */
const cwd = "/Users/someone/projects/symplist";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollTo ??= vi.fn();
});

function mount(bridge: FakeChatBridge, taskId: string | null = "task-1"): ReactNode {
  render(
    <SimonProvider bridge={bridge}>
      <ChatPane taskId={taskId} />
    </SimonProvider>,
  );
  return null;
}

/** Gets through the folder screen, which every conversation starts on. */
async function startSession(bridge: FakeChatBridge) {
  const user = userEvent.setup();
  mount(bridge);
  await user.click(await screen.findByRole("button", { name: /Choose/ }));
  await user.click(await screen.findByRole("button", { name: "Start" }));
  await screen.findByRole("textbox", { name: "Message Simon" });
  return user;
}

describe("the chat pane before a session exists", () => {
  it("asks for a project folder and says the conversation stays on this machine", async () => {
    const bridge = fakeChatBridge();
    mount(bridge);
    expect(await screen.findByRole("heading", { name: /Where should Simon work/ })).toBeTruthy();
    expect(screen.getByText(/never sent to the cloud/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toHaveProperty("disabled", true);
  });

  it("starts the session in the folder the shell picked", async () => {
    const bridge = fakeChatBridge();
    await startSession(bridge);
    expect(bridge.start).toHaveBeenCalledWith({ taskId: "task-1", cwd });
  });

  it("explains a missing model key instead of offering a retry that can only fail again", async () => {
    const failure = new Error("no key");
    (failure as { code?: string }).code = "chat.key_required";
    const bridge = fakeChatBridge({ startError: failure });
    const user = userEvent.setup();
    mount(bridge);
    await user.click(await screen.findByRole("button", { name: /Choose/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Settings → Models/)).toBeTruthy();
    expect(within(alert).getByText(/never leaves this device/)).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: /Try again/ })).toBeNull();
  });

  it("tells a browser plainly that the assistant is not here", () => {
    render(
      <SimonProvider bridge={null}>
        <ChatPane taskId="task-1" />
      </SimonProvider>,
    );
    expect(screen.getByText(/The assistant runs on your machine/)).toBeTruthy();
  });
});

describe("a turn that runs a command and edits a document section", () => {
  it("draws the command, its approval, its output and the Symplist edit", async () => {
    const bridge = fakeChatBridge();
    const user = await startSession(bridge);

    await user.type(screen.getByRole("textbox", { name: "Message Simon" }), "Fix the failing test");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(bridge.calls.prompts).toEqual([
      { conversationId: "conv-1", text: "Fix the failing test" },
    ]);
    expect(screen.getByText("Fix the failing test")).toBeTruthy();

    // The shell command: the card names it, and the permission card asks about it by joining the tool
    // call id, because the harness's request carries nothing else.
    bridge.emitUpdate(
      "conv-1",
      toolCallUpdate("c1", "bash", { command: "pnpm --filter @symplist/web test" }),
    );
    bridge.emit("conv-1", { type: "permission", request: fakePermission("c1", "req-1") });
    const card = await screen.findByRole("region", { name: /Simon needs your permission/ });
    expect(within(card).getByText("Running a command on this machine.")).toBeTruthy();
    expect(within(card).getByText("pnpm --filter @symplist/web test")).toBeTruthy();
    // Exactly the two choices dsh offers, in order, and nothing that claims to be remembered.
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Allow once", "Reject"]);
    expect(within(card).getByText(/asks again next time/)).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: "Allow once" }));
    expect(bridge.calls.permissions).toEqual([{ requestId: "req-1", optionId: "allow-once" }]);
    bridge.emit("conv-1", { type: "permission_settled", requestId: "req-1" });
    bridge.emitUpdate("conv-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "1 failed, 40 passed" } }],
    });
    expect(await screen.findByText("1 failed, 40 passed")).toBeTruthy();

    // The other half of the thesis: a document section edited through Symplist's own MCP server.
    bridge.emitUpdate(
      "conv-1",
      toolCallUpdate("c2", "mcp__symplist__task_document_update_section", {
        heading: "Next steps",
      }),
    );
    expect(await screen.findByText("Updating a section")).toBeTruthy();
    expect(screen.getByText("Next steps")).toBeTruthy();
    bridge.emitUpdate("conv-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "c2",
      status: "completed",
    });
    bridge.emitUpdate("conv-1", messageUpdate("m1", "Fixed and written up."));
    bridge.emit("conv-1", { type: "turn_ended", stopReason: "end_turn" });
    expect(await screen.findByText("Fixed and written up.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true),
    );
  });

  it("shows the tool it is running while a turn is in flight, since nothing streams", async () => {
    // There is no token streaming on this wire, so the tool lifecycle is the progress bar. If this strip
    // says nothing useful a long turn looks hung, and the fix is on the far side of ACP.
    const bridge = fakeChatBridge();
    const user = await startSession(bridge);
    await user.type(screen.getByRole("textbox", { name: "Message Simon" }), "go");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    const strip = await screen.findByRole("status");
    expect(strip.textContent).toBe("Thinking…");
    bridge.emitUpdate("conv-1", toolCallUpdate("c1", "grep", { pattern: "TODO" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Searching the files…"),
    );
  });

  it("refuses a second prompt while one is in flight, rather than pretending to queue it", async () => {
    const bridge = fakeChatBridge();
    const user = await startSession(bridge);
    const box = screen.getByRole("textbox", { name: "Message Simon" });
    await user.type(box, "first");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(box).toHaveProperty("disabled", true));
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
    bridge.emit("conv-1", { type: "turn_ended", stopReason: "end_turn" });
    await waitFor(() => expect(box).toHaveProperty("disabled", false));
    expect(bridge.calls.prompts).toHaveLength(1);
  });

  it("stops a turn and answers an outstanding permission so the agent is not left waiting", async () => {
    const bridge = fakeChatBridge();
    const user = await startSession(bridge);
    await user.type(screen.getByRole("textbox", { name: "Message Simon" }), "go");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    bridge.emit("conv-1", { type: "permission", request: fakePermission("c1", "req-9") });
    await screen.findByRole("region", { name: /permission/ });
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(bridge.calls.permissions).toEqual([{ requestId: "req-9", optionId: "cancelled" }]);
    expect(bridge.calls.cancels).toEqual(["conv-1"]);
  });

  it("says what happened when a turn ends for a reason worth naming", async () => {
    const bridge = fakeChatBridge();
    const user = await startSession(bridge);
    await user.type(screen.getByRole("textbox", { name: "Message Simon" }), "go");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    bridge.emit("conv-1", { type: "turn_ended", stopReason: "max_tokens" });
    expect(await screen.findByText(/ran out of room in this conversation/)).toBeTruthy();
  });

  it("reports a refused prompt and releases the composer", async () => {
    const bridge = fakeChatBridge({ promptError: new Error("The assistant stopped responding.") });
    const user = await startSession(bridge);
    await user.type(screen.getByRole("textbox", { name: "Message Simon" }), "go");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The assistant stopped responding.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message Simon" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
  });
});

describe("history and the agent's memory", () => {
  it("replays a stored transcript and offers the page before it", async () => {
    const bridge = fakeChatBridge({
      history: {
        updates: [{ seq: 4, receivedAt: 4, update: messageUpdate("m1", "From yesterday.") }],
        nextBeforeSeq: 4,
      },
    });
    await startSession(bridge);
    expect(await screen.findByText("From yesterday.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Load earlier messages/ })).toBeTruthy();
  });

  it("says plainly that the agent has forgotten the messages above the divider", async () => {
    // ACP has no transcript replay, so a conversation whose dsh session is gone keeps our history and
    // loses the agent's. Hiding that would leave the person confused by the next answer.
    const bridge = fakeChatBridge({
      memoryReset: true,
      history: {
        updates: [{ seq: 1, receivedAt: 1, update: messageUpdate("m1", "Older answer.") }],
        nextBeforeSeq: null,
      },
    });
    await startSession(bridge);
    expect(await screen.findByText(/does not remember the messages above this line/)).toBeTruthy();
    expect(screen.getByText("Older answer.")).toBeTruthy();
  });

  it("offers the model the harness advertises and applies a change to the next turn", async () => {
    const bridge = fakeChatBridge();
    const user = await startSession(bridge);
    bridge.emitUpdate("conv-1", {
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
      ],
    });
    const select = await screen.findByRole("combobox", { name: "Simon’s model" });
    await user.selectOptions(select, "route-b");
    expect(bridge.calls.configs).toEqual([{ id: "model", value: "route-b" }]);
  });

  it("shows how much of the context the conversation is using", async () => {
    const bridge = fakeChatBridge();
    await startSession(bridge);
    bridge.emitUpdate("conv-1", { sessionUpdate: "usage_update", used: 64_000, size: 128_000 });
    expect(await screen.findByText(/50% of context/)).toBeTruthy();
  });
});
