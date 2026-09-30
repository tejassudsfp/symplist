import type { AcpPermissionRequest } from "@symplist/contracts";
import { vi } from "vitest";
import type {
  ChatBridge,
  ChatBridgeEvent,
  ChatConversationSummary,
  ChatHistoryPage,
  ChatPromptBlock,
  ChatSession,
} from "./bridge.ts";

/**
 * A fake desktop chat bridge.
 *
 * The whole reason `bridge.ts` is the only file in the web that touches `window.symplist` is so this
 * object can stand in for Electron everywhere else. It records what the renderer asked for, and `emit`
 * pushes an event back the way main would.
 */
export interface FakeChatBridge extends ChatBridge {
  /** Pushes one event to every subscriber of a conversation. */
  emit(conversationId: string, event: ChatBridgeEvent): void;
  /**
   * Pushes one ACP update, numbering it the way main does. The sequence is main's to assign, so a test
   * that had to invent one would be asserting something about itself.
   */
  emitUpdate(conversationId: string, update: unknown): void;
  readonly calls: {
    readonly prompts: { conversationId: string; text: string }[];
    readonly cancels: string[];
    readonly permissions: { requestId: string; optionId: string }[];
    readonly configs: { id: string; value: string | boolean }[];
  };
}

export interface FakeBridgeOptions {
  readonly conversationId?: string;
  readonly cwd?: string;
  readonly memoryReset?: boolean;
  readonly history?: ChatHistoryPage;
  readonly conversations?: readonly ChatConversationSummary[];
  /** Makes `prompt` reject, which is how a refused turn or a dead harness reaches the renderer. */
  readonly promptError?: Error;
  readonly startError?: Error;
}

export function fakeChatBridge(options: FakeBridgeOptions = {}): FakeChatBridge {
  const conversationId = options.conversationId ?? "conv-1";
  const cwd = options.cwd ?? "/Users/someone/projects/symplist";
  const listeners = new Map<string, Set<(event: ChatBridgeEvent) => void>>();
  const calls = {
    prompts: [] as { conversationId: string; text: string }[],
    cancels: [] as string[],
    permissions: [] as { requestId: string; optionId: string }[],
    configs: [] as { id: string; value: string | boolean }[],
  };
  let seq = 0;
  const publish = (id: string, event: ChatBridgeEvent): void => {
    for (const listener of listeners.get(id) ?? []) listener(event);
  };
  return {
    calls,
    emit: publish,
    emitUpdate(id, update) {
      seq += 1;
      publish(id, { type: "update", seq, update });
    },
    list: vi.fn(
      async (): Promise<readonly ChatConversationSummary[]> => options.conversations ?? [],
    ),
    start: vi.fn(async (): Promise<ChatSession> => {
      if (options.startError) throw options.startError;
      return { conversationId, cwd, memoryReset: options.memoryReset ?? false };
    }),
    prompt: vi.fn(async (id: string, blocks: readonly ChatPromptBlock[]) => {
      const text = blocks.map((block) => (block.type === "text" ? block.text : block.uri)).join("");
      calls.prompts.push({ conversationId: id, text });
      if (options.promptError) throw options.promptError;
    }),
    cancel: vi.fn(async (id: string) => {
      calls.cancels.push(id);
    }),
    answerPermission: vi.fn(async (requestId: string, optionId: string) => {
      calls.permissions.push({ requestId, optionId });
    }),
    setConfig: vi.fn(async (_id: string, id: string, value: string | boolean) => {
      calls.configs.push({ id, value });
    }),
    history: vi.fn(
      async (): Promise<ChatHistoryPage> => options.history ?? { updates: [], nextBeforeSeq: null },
    ),
    subscribe: vi.fn((id: string, listener: (event: ChatBridgeEvent) => void) => {
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => set.delete(listener);
    }),
    chooseDirectory: vi.fn(async () => cwd),
  };
}

/** The permission request `dsh-acp` sends: a tool call id, and allow-once / reject-once. */
export function fakePermission(toolCallId = "call-1", requestId = "req-1"): AcpPermissionRequest {
  return {
    requestId,
    sessionId: "session-1",
    toolCall: { toolCallId },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  };
}

/** A `tool_call` update in the exact shape the harness emits. */
export function toolCallUpdate(
  toolCallId: string,
  name: string,
  rawInput?: unknown,
): { sessionUpdate: "tool_call"; [key: string]: unknown } {
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: name,
    kind: "other",
    status: "in_progress",
    ...(rawInput === undefined ? {} : { rawInput }),
  };
}

/** An `agent_message_chunk` update. */
export function messageUpdate(messageId: string, text: string): Record<string, unknown> {
  return { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } };
}
