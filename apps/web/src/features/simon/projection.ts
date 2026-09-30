import type {
  AcpConfigOption,
  AcpPermissionRequest,
  AcpSessionUpdate,
  AcpStopReason,
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpToolKind,
} from "@symplist/contracts";
import { acpBlockText, parseAcpUpdate } from "@symplist/contracts";

/**
 * The pure reducer from ACP notifications to what the chat pane draws.
 *
 * Two things force this shape. First, `dsh-acp` states in two places that resuming a session "does not
 * replay history", so the transcript cannot come from the harness — Symplist has to keep it, and the
 * cheapest thing to keep faithfully is the wire itself. Second, if history were rebuilt by a different
 * code path from the live pane the two would drift, and a projection bug would need fixing twice. So the
 * Electron main process appends every raw update to a local SQLite file and the renderer replays those
 * rows through this same function. One rendering path, one place to fix.
 *
 * It is deliberately total and deliberately dull: no throwing, no clock, no ids of its own. Everything
 * that needs a decision — which message a chunk belongs to, whether a tool call is still running — is
 * already on the wire.
 */

/** A tool call as the pane shows it: the harness's own fields, accumulated. */
export interface ChatToolCall {
  readonly kind: "tool";
  readonly toolCallId: string;
  /**
   * `dsh-acp` puts the tool's *programmatic* name here (`bash`,
   * `mcp__symplist__task_document_update_section`), not a sentence. `tool-labels.ts` turns it into
   * something worth reading; this stays raw so the label table is the only place wording lives.
   */
  readonly name: string;
  /**
   * ACP's category. The harness hardcodes `"other"` for every call, so nothing may branch on this
   * alone — the icon and the label come from `name`. It is kept because a later harness may fill it.
   */
  readonly toolKind: AcpToolKind;
  readonly status: AcpToolCallStatus;
  readonly content: readonly AcpToolCallContent[];
  readonly locations: readonly AcpToolCallLocation[];
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
}

/** A person's turn. Added by the store when a prompt is sent, never by an ACP update. */
export interface ChatUserMessage {
  readonly kind: "user";
  readonly id: string;
  readonly text: string;
}

/** Committed assistant prose. One bubble per `messageId`; a new id starts a new bubble. */
export interface ChatAssistantMessage {
  readonly kind: "assistant";
  readonly messageId: string;
  readonly text: string;
}

/**
 * The assistant's reasoning, kept separate from its prose. It is shown as progress during a turn and
 * folded away afterwards: it is the harness's working-out, not its answer.
 */
export interface ChatThought {
  readonly kind: "thought";
  readonly messageId: string;
  readonly text: string;
}

export type ChatItem = ChatUserMessage | ChatAssistantMessage | ChatThought | ChatToolCall;

/** Context occupancy, the one number the harness volunteers about the model's state. */
export interface ChatUsage {
  readonly used: number;
  readonly size: number;
}

export interface ChatProjection {
  readonly items: readonly ChatItem[];
  /** The permission the harness is blocked on, if any. Exactly one at a time per session. */
  readonly pendingPermission: AcpPermissionRequest | null;
  readonly usage: ChatUsage | null;
  /** The harness's advertised session options — the model selector comes from here. */
  readonly configOptions: readonly AcpConfigOption[];
  /** Why the last finished turn ended, or null before the first one has. */
  readonly stopReason: AcpStopReason | null;
  /**
   * Set when the conversation's dsh session could not be resumed and a fresh one was started. The
   * transcript above this point is ours and is intact; the agent's memory of it is not, and the pane
   * says so rather than letting the person discover it by being misunderstood.
   */
  readonly memoryResetAfter: number | null;
}

export const emptyChatProjection: ChatProjection = {
  items: [],
  pendingPermission: null,
  usage: null,
  configOptions: [],
  stopReason: null,
  memoryResetAfter: null,
};

/** Every event the projection folds: ACP notifications plus the few things only the client knows. */
export type ChatEvent =
  | { readonly type: "update"; readonly update: unknown }
  | { readonly type: "user"; readonly id: string; readonly text: string }
  | { readonly type: "permission"; readonly request: AcpPermissionRequest }
  | { readonly type: "permission_settled" }
  | { readonly type: "turn_ended"; readonly stopReason: AcpStopReason }
  | { readonly type: "turn_started" }
  | { readonly type: "memory_reset" };

function replaceAt(items: readonly ChatItem[], index: number, item: ChatItem): readonly ChatItem[] {
  const next = items.slice();
  next[index] = item;
  return next;
}

/**
 * Appends a chunk to the trailing item when it belongs to the same message, and starts a new one
 * otherwise. "Trailing" rather than "matching anywhere" is the point: ACP guarantees ordered delivery
 * per session, so a chunk for an earlier message id after something else has been said means the
 * harness reused an id, and a new bubble is the honest rendering of that.
 */
function appendText(
  items: readonly ChatItem[],
  kind: "assistant" | "thought",
  messageId: string,
  text: string,
): readonly ChatItem[] {
  if (!text) return items;
  const index = items.length - 1;
  const last = items[index];
  if (last && last.kind === kind && last.messageId === messageId)
    return replaceAt(items, index, { ...last, text: last.text + text });
  return [...items, { kind, messageId, text }];
}

/**
 * A messageId for a chunk that arrives without one. The harness always sends one, but ACP makes it
 * optional, and grouping every id-less chunk under one key would glue unrelated messages together —
 * so an anonymous chunk gets the position it arrived at, which keeps it on its own.
 */
function anonymousMessageId(items: readonly ChatItem[], kind: string): string {
  return `${kind}:${items.length}`;
}

function toolCallIndex(items: readonly ChatItem[], toolCallId: string): number {
  return items.findIndex((item) => item.kind === "tool" && item.toolCallId === toolCallId);
}

function reduceUpdate(state: ChatProjection, update: AcpSessionUpdate): ChatProjection {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const kind = update.sessionUpdate === "agent_message_chunk" ? "assistant" : "thought";
      const messageId = update.messageId ?? anonymousMessageId(state.items, kind);
      return {
        ...state,
        items: appendText(state.items, kind, messageId, acpBlockText(update.content)),
      };
    }
    case "user_message_chunk": {
      // The harness does not echo prompts back, but ACP allows it and a resumed transcript could carry
      // one. Rendering it as the person's own turn keeps a replay honest without a second code path.
      const text = acpBlockText(update.content);
      if (!text) return state;
      const id = update.messageId ?? anonymousMessageId(state.items, "user");
      const index = state.items.length - 1;
      const last = state.items[index];
      if (last?.kind === "user" && last.id === id)
        return {
          ...state,
          items: replaceAt(state.items, index, { ...last, text: last.text + text }),
        };
      return { ...state, items: [...state.items, { kind: "user", id, text }] };
    }
    case "tool_call": {
      const call: ChatToolCall = {
        kind: "tool",
        toolCallId: update.toolCallId,
        name: update.name ?? update.title,
        toolKind: update.kind ?? "other",
        status: update.status ?? "pending",
        content: update.content ?? [],
        locations: update.locations ?? [],
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
      };
      const existing = toolCallIndex(state.items, update.toolCallId);
      // A repeated `tool_call` for a live id is the harness restating the call, not a second card.
      return existing >= 0
        ? { ...state, items: replaceAt(state.items, existing, call) }
        : { ...state, items: [...state.items, call] };
    }
    case "tool_call_update": {
      const index = toolCallIndex(state.items, update.toolCallId);
      // An update for a call we never saw start is dropped: inventing a card titled after an id would
      // put a row in the transcript that says nothing, and the missing `tool_call` is the real problem.
      if (index < 0) return state;
      const current = state.items[index] as ChatToolCall;
      // Field by present field. ACP's rule is that an absent or null field means "unchanged", so a
      // status-only update must not wipe the content an earlier one delivered.
      const next: ChatToolCall = {
        ...current,
        ...(update.name != null ? { name: update.name } : {}),
        ...(update.title != null && update.name == null ? { name: update.title } : {}),
        ...(update.kind != null ? { toolKind: update.kind } : {}),
        ...(update.status != null ? { status: update.status } : {}),
        ...(update.content != null ? { content: update.content } : {}),
        ...(update.locations != null ? { locations: update.locations } : {}),
        ...("rawInput" in update && update.rawInput !== undefined
          ? { rawInput: update.rawInput }
          : {}),
        ...("rawOutput" in update && update.rawOutput !== undefined
          ? { rawOutput: update.rawOutput }
          : {}),
      };
      return { ...state, items: replaceAt(state.items, index, next) };
    }
    case "usage_update":
      return { ...state, usage: { used: update.used, size: update.size } };
    case "config_option_update":
      return { ...state, configOptions: update.configOptions };
  }
}

/** Folds one event into the projection. Unknown and malformed updates leave it exactly as it was. */
export function reduceChat(state: ChatProjection, event: ChatEvent): ChatProjection {
  switch (event.type) {
    case "update": {
      const update = parseAcpUpdate(event.update);
      return update ? reduceUpdate(state, update) : state;
    }
    case "user":
      return {
        ...state,
        items: [...state.items, { kind: "user", id: event.id, text: event.text }],
      };
    case "permission":
      return { ...state, pendingPermission: event.request };
    case "permission_settled":
      return { ...state, pendingPermission: null };
    case "turn_started":
      return { ...state, stopReason: null };
    case "turn_ended":
      // A turn that ends always clears the permission gate: the harness is no longer waiting on us, so
      // a card left on screen would invite an answer that can never be delivered.
      return { ...state, stopReason: event.stopReason, pendingPermission: null };
    case "memory_reset":
      return { ...state, memoryResetAfter: state.items.length };
  }
}

/** Replays a stored transcript. The same fold the live pane uses, which is the whole point of it. */
export function replayChat(
  events: readonly ChatEvent[],
  initial: ChatProjection = emptyChatProjection,
): ChatProjection {
  return events.reduce(reduceChat, initial);
}

/**
 * What the working strip says while a turn runs: the newest tool call still in flight, else the newest
 * line of reasoning, else nothing and the caller falls back to "Thinking".
 *
 * There is no token streaming on this wire — `dsh-acp` converts *committed* assistant messages, and
 * says raw provider deltas "stay off the wire" — so the tool lifecycle is the only progress signal
 * there is. That makes this function the difference between a long turn that looks alive and one that
 * looks hung.
 */
export function workingLine(
  state: ChatProjection,
): { kind: "tool" | "thought"; text: string } | null {
  for (let index = state.items.length - 1; index >= 0; index--) {
    const item = state.items[index];
    if (!item) continue;
    if (item.kind === "tool" && (item.status === "pending" || item.status === "in_progress"))
      return { kind: "tool", text: item.name };
    if (item.kind === "thought") {
      const line = item.text.trim().split("\n").filter(Boolean).at(-1);
      if (line) return { kind: "thought", text: line };
    }
  }
  return null;
}

/** The tool call a permission request is about, joined by id, or null when it has not arrived yet. */
export function permissionSubject(state: ChatProjection): ChatToolCall | null {
  const id = state.pendingPermission?.toolCall.toolCallId;
  if (!id) return null;
  const index = toolCallIndex(state.items, id);
  return index >= 0 ? (state.items[index] as ChatToolCall) : null;
}

/** The `select` option the harness advertises under an id, for the model picker. */
export function selectOption(state: ChatProjection, id: string): AcpConfigOption | null {
  return state.configOptions.find((option) => option.id === id && option.type === "select") ?? null;
}
