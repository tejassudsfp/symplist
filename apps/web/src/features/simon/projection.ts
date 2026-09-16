import {
  simonConversationViewSchema,
  type simonHistoryMessageSchema,
  type simonVisiblePartSchema,
} from "@symplist/contracts";

export type ConversationView = typeof simonConversationViewSchema._output;
export type ChatMessage = typeof simonHistoryMessageSchema._output;
export type VisiblePart = typeof simonVisiblePartSchema._output;
export interface LiveReply {
  readonly runId: string;
  readonly texts: ReadonlyMap<string, string>;
  readonly tools: ReadonlyMap<string, Extract<VisiblePart, { type: "tool" }>>;
  readonly ended: boolean;
}
export interface ChatProjection {
  readonly view: ConversationView | null;
  readonly live: LiveReply | null;
  readonly cursor: number;
}
export const emptyProjection: ChatProjection = { view: null, live: null, cursor: 0 };

/** Keep explicitly loaded older pages when the live head is refreshed. */
export function retainOlder(
  previous: ConversationView | null,
  next: ConversationView,
): ConversationView {
  if (!previous || previous.conversationId !== next.conversationId) return next;
  const first = next.messages[0]?.seq;
  if (first === undefined) return next;
  const older = previous.messages.filter((message) => message.seq < first);
  return older.length
    ? {
        ...next,
        messages: [...older, ...next.messages],
        nextBeforeSeq: previous.nextBeforeSeq,
      }
    : next;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function applyChunk(live: LiveReply | null, runId: string, value: unknown): LiveReply | null {
  const chunk = record(value);
  if (!chunk || typeof chunk.type !== "string") return live;
  if (chunk.type === "start")
    return live?.runId === runId
      ? live
      : { runId, texts: new Map(), tools: new Map(), ended: false };
  // A truncated replay cannot safely append to a checkpoint. Wait for the next saved snapshot.
  if (!live || live.runId !== runId || live.ended) return live;
  if (chunk.type === "finish" || chunk.type === "abort" || chunk.type === "error")
    return { ...live, ended: true };
  if (typeof chunk.id === "string" && chunk.id.length <= 128) {
    const texts = new Map(live.texts);
    if (chunk.type === "text-start" && texts.size < 100 && !texts.has(chunk.id))
      texts.set(chunk.id, "");
    else if (
      chunk.type === "text-delta" &&
      texts.has(chunk.id) &&
      typeof chunk.delta === "string"
    ) {
      // Match the relay's bounded live window; a later persisted snapshot repairs dropped tails.
      const current = texts.get(chunk.id) ?? "";
      if (
        [...texts.values()].reduce((sum, text) => sum + text.length, 0) + chunk.delta.length >
        262144
      )
        return live;
      texts.set(chunk.id, current + chunk.delta);
    } else return live;
    return { ...live, texts };
  }
  if (typeof chunk.toolCallId !== "string" || chunk.toolCallId.length > 128) return live;
  const tools = new Map(live.tools);
  const previous = tools.get(chunk.toolCallId);
  if (
    (chunk.type === "tool-input-start" || chunk.type === "tool-input-available") &&
    typeof chunk.toolName === "string" &&
    tools.size < 100
  ) {
    if (!previous)
      tools.set(chunk.toolCallId, {
        type: "tool",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName.slice(0, 128),
        state: "input-available",
      });
  } else if (chunk.type === "tool-output-available" && previous)
    tools.set(chunk.toolCallId, { ...previous, state: "output-available" });
  else if ((chunk.type === "tool-output-error" || chunk.type === "tool-input-error") && previous)
    tools.set(chunk.toolCallId, { ...previous, state: "output-error", errorCode: "tool.failed" });
  else return live;
  // Live tool arguments, raw results, metadata and reasoning are deliberately never retained.
  return { ...live, tools };
}

export function projectEvent(
  state: ChatProjection,
  event: { seq: number; type: string; data: unknown },
): ChatProjection {
  if (event.seq <= state.cursor) return state;
  const next = { ...state, cursor: event.seq };
  if (event.type !== "chunk") return next;
  const data = record(event.data);
  if (!data || typeof data.runId !== "string") return next;
  if (state.view?.activeRun && data.runId !== state.view.activeRun.runId) return next;
  // Late output from an already finished run cannot replace its canonical persisted message.
  if (!state.view?.activeRun && state.view?.latestRun?.runId === data.runId) return next;
  return { ...next, live: applyChunk(state.live, data.runId, data.chunk) };
}

export function projectSnapshot(
  state: ChatProjection,
  conversationId: string,
  seq: number,
  data: unknown,
): ChatProjection {
  const raw = record(data);
  if (!raw) return state;
  const parsed = simonConversationViewSchema.safeParse({
    conversationId: raw.conversationId,
    kind: raw.kind,
    taskId: raw.taskId,
    activeRun: raw.activeRun,
    latestRun: raw.latestRun,
    pendingApprovalId: raw.pendingApprovalId,
    pendingAskId: raw.pendingAskId,
    messages: raw.messages,
    nextBeforeSeq: raw.nextBeforeSeq,
  });
  if (!parsed.success || parsed.data.conversationId !== conversationId) return state;
  let live: LiveReply | null = null;
  if (Array.isArray(raw.live)) {
    for (const candidate of raw.live.slice(-2000)) {
      const event = record(candidate);
      const output = record(event?.data);
      if (event?.type === "chunk" && output && output.runId === parsed.data.activeRun?.runId)
        live = applyChunk(live, String(output.runId), output.chunk);
    }
  }
  return { view: retainOlder(state.view, parsed.data), live, cursor: seq };
}

/** Live text replaces the matching checkpoint, never appends a duplicate assistant bubble. */
export function projectedMessages(state: ChatProjection): readonly ChatMessage[] {
  const saved = state.view?.messages ?? [];
  const live = state.live;
  if (!live) return saved;
  const existing = saved.find(
    (message) => message.role === "assistant" && message.runId === live.runId,
  );
  const text = [...live.texts.values()].join("");
  if (!text && !live.tools.size) return saved;
  const message: ChatMessage = {
    id: existing?.id ?? live.runId,
    seq: existing?.seq ?? (saved.at(-1)?.seq ?? 0) + 1,
    role: "assistant",
    status: "accepted",
    runId: live.runId,
    text,
    parts: [...live.tools.values(), ...(text ? [{ type: "text" as const, text }] : [])],
  };
  return existing
    ? saved.map((row) => (row.id === existing.id ? message : row))
    : [...saved, message];
}
