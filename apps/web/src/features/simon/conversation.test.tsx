import { simonConversationViewSchema } from "@symplist/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSimonApi, type SimonApi } from "./api.ts";
import { ChatPane } from "./chat-pane.tsx";
import { SimonProvider } from "./provider.tsx";
import { QuickChatLauncher } from "./quick-chat.tsx";

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
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(client.history).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Close and delete quick chat" }));
    await waitFor(() => expect(client.close).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.close.mock.calls[0]?.[0]).toBe(id);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Simon" })).toHaveFocus());
  });
});
