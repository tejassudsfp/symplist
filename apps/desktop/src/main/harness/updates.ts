/**
 * Turning ACP's wire shapes into the timeline the renderer draws. Pure functions, no `electron` and
 * no `node:*`, so every mapping decision below is exercised by a test rather than by a running
 * harness.
 *
 * The shapes are ACP's, and two of them repay a moment's attention.
 *
 * `agent_message_chunk` is not a token delta. `dsh-acp` emits it from a *committed*
 * `assistant/message` event — its stated commitment is "standard semantic updates only… raw
 * provider deltas stay off the wire". A chunk is therefore a whole message, and appending chunks
 * with the same `messageId` is coalescing committed parts, not assembling a stream.
 *
 * `tool_call_update` carries only the fields that changed, and `content` and `locations` *replace*
 * their collections rather than extending them. So the merge below overwrites where ACP says replace
 * and keeps the previous value where a field is absent, and it must not treat `null` as "clear":
 * ACP spells an absent update as `null` in several of these fields.
 */
import type {
  ContentBlock,
  SessionConfigOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type {
  AssistantOption,
  AssistantOptionChoice,
  AssistantTimelineEntry,
  AssistantToolStatus,
} from "../../shared/assistant.ts";

/** Text out of a content block. Non-text blocks become a one-word placeholder, never their bytes. */
export function contentBlockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return `[${block.name}](${block.uri})`;
    case "resource":
      return "text" in block.resource ? block.resource.text : "[binary resource]";
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      return "";
  }
}

/** Text out of a tool's reported content. A diff is summarised by its path, never inlined whole. */
export function toolContentText(content: readonly ToolCallContent[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "content") parts.push(contentBlockText(item.content));
    else if (item.type === "diff") parts.push(`--- ${item.path}`);
    else parts.push(`[terminal ${item.terminalId}]`);
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

/**
 * The running state of one tool call. Kept because ACP sends partial updates: a `tool_call_update`
 * that only moves the status still has to produce a complete timeline entry.
 */
export interface ToolCallState {
  readonly id: string;
  title: string;
  name: string | null;
  status: AssistantToolStatus;
  output: string;
}

/** Fold a `tool_call_update` into the state a `tool_call` started. `null` means "unchanged". */
export function mergeToolCall(state: ToolCallState, update: ToolCallUpdate): ToolCallState {
  if (typeof update.title === "string") state.title = update.title;
  if (typeof update.name === "string") state.name = update.name;
  if (update.status != null) state.status = update.status;
  // `content` replaces the collection rather than appending to it, so the text is recomputed whole.
  if (update.content != null) state.output = toolContentText(update.content);
  return state;
}

/**
 * Flatten a select option's choices. ACP allows either a flat list or a list of groups, and the
 * model option uses groups (one per provider route), so the group name is carried onto each choice
 * rather than thrown away — a picker showing thirty bare model names with no provider is unusable.
 */
export function optionChoices(option: SessionConfigOption): readonly AssistantOptionChoice[] {
  if (option.type !== "select") return [];
  const choices: AssistantOptionChoice[] = [];
  for (const entry of option.options) {
    if ("group" in entry) {
      for (const choice of entry.options) {
        choices.push({
          value: choice.value,
          name: choice.name,
          description: choice.description ?? null,
          group: entry.name,
        });
      }
    } else {
      choices.push({
        value: entry.value,
        name: entry.name,
        description: entry.description ?? null,
        group: null,
      });
    }
  }
  return choices;
}

/**
 * The configuration state as the renderer renders it. dsh publishes the complete set on creation,
 * resume and every change, so this is a whole snapshot every time.
 *
 * A `boolean` option's value is stringified rather than dropped: the renderer treats `currentValue`
 * as opaque and hands it straight back to `set-option`, which is what keeps this layer from having
 * to know what any given option means.
 */
export function toAssistantOptions(
  options: readonly SessionConfigOption[] | null | undefined,
): readonly AssistantOption[] {
  if (!options) return [];
  return options.map((option) => ({
    id: option.id,
    name: option.name,
    description: option.description ?? null,
    currentValue: String(option.currentValue),
    choices: optionChoices(option),
  }));
}

/** What one `session/update` notification produced, for the supervisor to fan out. */
export type UpdateEffect =
  | { readonly kind: "entry"; readonly entry: AssistantTimelineEntry }
  | { readonly kind: "options"; readonly options: readonly AssistantOption[] }
  | { readonly kind: "ignored" };

export interface UpdateContext {
  /** Live tool calls by id, owned by the caller so it survives across notifications. */
  readonly tools: Map<string, ToolCallState>;
  readonly now: () => number;
}

/**
 * Project one ACP update onto the timeline.
 *
 * The updates that map to nothing are ignored on purpose, not for lack of support: `dsh-acp`
 * documents that it omits plans, todos, terminal views and elicitation, so `plan`, `plan_update`,
 * `plan_removed`, `available_commands_update` and `current_mode_update` never arrive from this
 * agent. `usage_update` and the compaction updates do arrive and are real, but they describe the
 * context window rather than the conversation, and inventing timeline entries for them would put
 * bookkeeping in the middle of what the user is reading.
 */
export function projectUpdate(update: SessionUpdate, context: UpdateContext): UpdateEffect {
  const at = context.now();
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return {
        kind: "entry",
        entry: {
          kind: "user",
          id: update.messageId ?? `user-${at}`,
          at,
          text: contentBlockText(update.content),
        },
      };
    case "agent_message_chunk":
      return {
        kind: "entry",
        entry: {
          kind: "message",
          id: update.messageId ?? `message-${at}`,
          at,
          text: contentBlockText(update.content),
        },
      };
    case "agent_thought_chunk":
      return {
        kind: "entry",
        entry: {
          kind: "thought",
          id: update.messageId ?? `thought-${at}`,
          at,
          text: contentBlockText(update.content),
        },
      };
    case "tool_call": {
      const state: ToolCallState = {
        id: update.toolCallId,
        title: update.title,
        name: update.name ?? null,
        status: update.status ?? "pending",
        output: toolContentText(update.content ?? []),
      };
      context.tools.set(state.id, state);
      return { kind: "entry", entry: toolEntry(state, at) };
    }
    case "tool_call_update": {
      // A first sighting through an update is possible when a turn is resumed or a notification is
      // dropped; treating it as a new call keeps the timeline complete rather than silently short.
      const existing = context.tools.get(update.toolCallId) ?? {
        id: update.toolCallId,
        title: update.title ?? update.toolCallId,
        name: update.name ?? null,
        status: "pending" as AssistantToolStatus,
        output: "",
      };
      const merged = mergeToolCall(existing, update);
      context.tools.set(merged.id, merged);
      return { kind: "entry", entry: toolEntry(merged, at) };
    }
    case "config_option_update":
      return { kind: "options", options: toAssistantOptions(update.configOptions) };
    default:
      return { kind: "ignored" };
  }
}

function toolEntry(state: ToolCallState, at: number): AssistantTimelineEntry {
  return {
    kind: "tool",
    id: state.id,
    at,
    title: state.title,
    name: state.name,
    status: state.status,
    output: state.output,
  };
}
