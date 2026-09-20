import { simonConversationViewSchema } from "@symplist/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outlineRequestHandler } from "@/features/documents/outline-request";
import { handoffDraftHandler } from "@/features/sharing/handoff-draft";
import { createSimonApi, type SimonApi } from "./api.ts";
import { ChatPane } from "./chat-pane.tsx";
import { SimonProvider } from "./provider.tsx";
import { QuickChatLauncher } from "./quick-chat.tsx";

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/features/analytics/runtime", () => ({ track: analytics.track }));

const id = "01995000-0000-7000-8000-000000000001";
const task = "01995000-0000-7000-8000-000000000002";
const run = "01995000-0000-7000-8000-000000000003";
const view = simonConversationViewSchema.parse({
  conversationId: id,
  kind: "task",
  taskId: task,
  activeRun: null,
  pendingApprovalId: null,
  pendingAskId: null,
  messages: [],
  nextBeforeSeq: null,
});
function api() {
  return {
    ...createSimonApi(),
    create: vi.fn<SimonApi["create"]>(async () => ({ conversationId: id })),
    history: vi.fn<SimonApi["history"]>(async () => view),
    send: vi.fn<SimonApi["send"]>(async () => ({ runId: run, messageId: run, status: "accepted" })),
    close: vi.fn<SimonApi["close"]>(async () => ({ conversationId: id, runId: null })),
    save: vi.fn<SimonApi["save"]>(async () => ({
      conversationId: id,
      taskId: task,
      collection: "now",
    })),
  };
}
beforeEach(() => {
  analytics.track.mockReset();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Simon conversation surfaces", () => {
  it("registers the empty-page outline seam, preserving a draft for the task", async () => {
    const client = api();
    const rendered = render(
      <StrictMode>
        <SimonProvider userId="owner" api={client} realtime={null}>
          <ChatPane taskId={task} />
        </SimonProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(outlineRequestHandler()).not.toBeNull());
    await outlineRequestHandler()?.(task);
    expect(screen.getByRole("textbox", { name: "Message Simon" })).toHaveValue(
      "Create a concise outline for this task page.",
    );
    rendered.unmount();
    expect(outlineRequestHandler()).toBeNull();
  });
  it("mounts real AI Elements and memoized stores through Strict Mode, then sends", async () => {
    const client = api();
    render(
      <StrictMode>
        <SimonProvider userId="owner" api={client} realtime={null}>
          <ChatPane taskId={task} />
        </SimonProvider>
      </StrictMode>,
    );
    const input = screen.getByRole("textbox", { name: "Message Simon" });
    fireEvent.change(input, { target: { value: "A real message" } });
    const send = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(client.send).toHaveBeenCalledOnce());
    expect(client.send.mock.calls[0]?.slice(0, 2)).toEqual([
      id,
      { text: "A real message", tier: "fast" },
    ]);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.getByRole("log", { name: "Conversation with Simon" })).toBeInTheDocument();
  });
  it("re-registers handoff drafting after Strict Mode cleanup and uses the task conversation", async () => {
    const client = api();
    const draft = "## Objective\nPrepare a bounded specialist handoff";
    client.send.mockImplementationOnce(async () => {
      client.history.mockResolvedValue({
        ...view,
        latestRun: {
          runId: run,
          conversationId: id,
          taskId: task,
          status: "completed",
          tier: "fast",
          stopRequested: false,
          outcomeCode: null,
        },
        messages: [
          {
            id: run,
            seq: 2,
            role: "assistant",
            status: "completed",
            runId: run,
            text: draft,
            parts: [],
          },
        ],
      });
      return {
        messageId: "01995000-0000-7000-8000-000000000004",
        runId: run,
        status: "accepted",
      };
    });
    const rendered = render(
      <StrictMode>
        <SimonProvider userId="owner" api={client} realtime={null}>
          <p>Handoff surface</p>
        </SimonProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(handoffDraftHandler()).not.toBeNull());
    const handler = handoffDraftHandler();
    if (!handler) throw new Error("handoff draft handler not registered");
    await expect(
      handler({
        taskId: task,
        revision: "a".repeat(40),
        target: "coding_assistant",
        outcome: "Prepare the implementation",
        artifactIds: ["01995000-0000-7000-8000-000000000005"],
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(draft);
    expect(client.send.mock.calls[0]?.[1].text).not.toContain("PRIVATE_DOCUMENT_PLAINTEXT");
    rendered.unmount();
    expect(handoffDraftHandler()).toBeNull();
  });
  it("renders saved Markdown without active HTML or remote tracking images", async () => {
    const client = api();
    client.history.mockResolvedValue({
      ...view,
      messages: [
        {
          id: run,
          seq: 1,
          role: "assistant",
          status: "accepted",
          runId: run,
          text: '**Saved reply**\n\n<img src="https://tracker.invalid/raw">\n\n![Remote image](https://tracker.invalid/image.png)',
          parts: [],
        },
      ],
    });
    render(
      <SimonProvider userId="owner" api={client} realtime={null}>
        <ChatPane taskId={task} />
      </SimonProvider>,
    );
    expect(await screen.findByText("Saved reply")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: /Remote image/ })).toHaveAttribute(
      "href",
      "https://tracker.invalid/image.png",
    );
  });
  it("keeps Enter and composing Enter as newlines rather than sending", async () => {
    const client = api();
    render(
      <SimonProvider userId="owner" api={client} realtime={null}>
        <ChatPane taskId={task} />
      </SimonProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message Simon" });
    fireEvent.change(input, { target: { value: "Not sent" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(client.send).not.toHaveBeenCalled();
    expect(input).toHaveValue("Not sent");
  });
  it("shows an unavailable provider without offering a blind retry", async () => {
    const client = api();
    client.history.mockResolvedValue({
      ...view,
      latestRun: {
        runId: run,
        conversationId: id,
        taskId: task,
        tier: "fast",
        status: "failed",
        stopRequested: false,
        outcomeCode: "ai.unavailable",
      },
    });
    render(
      <SimonProvider userId="owner" api={client} realtime={null}>
        <ChatPane taskId={task} />
      </SimonProvider>,
    );
    expect(await screen.findByText(/not configured on this server/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry interrupted run" })).not.toBeInTheDocument();
  });
  it("closes and deletes a quick chat before returning focus to its launcher", async () => {
    const client = api();
    client.history.mockResolvedValue({ ...view, kind: "quick", taskId: null });
    render(
      <SimonProvider userId="owner" api={client} realtime={null}>
        <QuickChatLauncher />
      </SimonProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask Simon" }));
    expect(analytics.track).toHaveBeenCalledWith("quick_chat_started", { entry: "button" });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(client.history).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Close and delete quick chat" }));
    await waitFor(() => expect(client.close).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.close.mock.calls[0]?.[0]).toBe(id);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Simon" })).toHaveFocus());
  });
  it("deletes an unsaved quick chat when navigation unmounts it, but not during Strict Mode rehearsal", async () => {
    const client = api();
    client.history.mockResolvedValue({ ...view, kind: "quick", taskId: null });
    const rendered = render(
      <StrictMode>
        <SimonProvider userId="owner" api={client} realtime={null}>
          <QuickChatLauncher />
        </SimonProvider>
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask Simon" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(client.history).toHaveBeenCalled());
    await Promise.resolve();
    expect(client.close).not.toHaveBeenCalled();

    rendered.rerender(
      <StrictMode>
        <SimonProvider userId="owner" api={client} realtime={null}>
          <p>Selected task route</p>
        </SimonProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(client.close).toHaveBeenCalledOnce());
    expect(client.close.mock.calls[0]?.[0]).toBe(id);
  });
  it("does not delete a quick conversation after Save as task converts it", async () => {
    const client = api();
    client.history.mockResolvedValue({ ...view, kind: "quick", taskId: null });
    render(
      <SimonProvider userId="owner" api={client} realtime={null}>
        <QuickChatLauncher />
      </SimonProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask Simon" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(client.history).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Save as task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), {
      target: { value: "Keep this conversation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(client.save).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await Promise.resolve();
    expect(client.close).not.toHaveBeenCalled();
  });
});
