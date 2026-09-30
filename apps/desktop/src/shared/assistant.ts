/**
 * The assistant's IPC contract: the channels, payloads and events the renderer uses to talk to the
 * DeepSeek Harness running beside it. Main and preload are bundled separately, so this module is the
 * only place they agree on those names; nothing here may import `electron` or `node:*`.
 *
 * Three things shape it, and each one is a decision the harness made for us.
 *
 * **A turn is a request, not a stream.** `session/prompt` settles when the turn ends, so `prompt`
 * here is one `invoke` that resolves with a stop reason. Everything that happens during the turn
 * arrives out of band on `assistantEvent`.
 *
 * **There are no token deltas.** `dsh-acp`'s design commitment is "standard semantic updates
 * only… raw provider deltas stay off the wire": its `agent_message_chunk` is emitted from a
 * *committed* assistant message. So the renderer gets whole messages, thoughts and a tool-call
 * lifecycle, and a UI built around a typewriter would look dead between tool calls. The event union
 * below is deliberately shaped like that timeline instead.
 *
 * **Approvals stay ours.** `session/request_permission` is a request the agent is blocked on, so it
 * crosses to the renderer as an event carrying a `requestId` and comes back through
 * `assistantDecide`. The renderer draws Symplist's own approval card; dsh's own permission model is
 * never delegated to.
 */

/** Every channel the assistant group registers. Merged into `ipcChannels` in `./ipc.ts`. */
export const assistantChannels = Object.freeze({
  assistantStatus: "symplist:assistant/status",
  assistantOpen: "symplist:assistant/open",
  assistantPrompt: "symplist:assistant/prompt",
  assistantCancel: "symplist:assistant/cancel",
  assistantClose: "symplist:assistant/close",
  assistantSetOption: "symplist:assistant/set-option",
  assistantDecide: "symplist:assistant/decide",
  assistantTimeline: "symplist:assistant/timeline",
} as const);

/** The one main→renderer channel. Not an `invoke`: it is pushed as the turn unfolds. */
export const assistantEventChannel = "symplist:assistant/event";

/**
 * Why the assistant cannot run. Each value is a distinct thing the user must do, which is the whole
 * reason they are separate: the cloud's three AI outcomes (`ai.unavailable`, `ai.key_required`,
 * `ai.provider_failed`) earned their distinction by being answerable, and these inherit it.
 *
 * - `harness_missing` — this build shipped without a harness tree, or it was deleted. Reinstall.
 * - `key_required` — no provider key on this device. Offer the way to Settings → Models.
 * - `boot_failed` — the harness is present and refused to start. Show the labelled line it wrote.
 * - `provider_failed` — a model call failed. Retry is meaningful.
 */
export type AssistantUnavailableReason =
  | "harness_missing"
  | "key_required"
  | "boot_failed"
  | "provider_failed";

/** Which provider keys this device holds. Never the values — those never leave the main process. */
export interface AssistantProviderKeys {
  readonly openai: boolean;
  readonly anthropic: boolean;
}

/** What the renderer may learn about the assistant without opening a conversation. */
export interface AssistantStatus {
  /** Whether a prompt could succeed right now. False whenever `reason` is set. */
  readonly ready: boolean;
  /** Set when `ready` is false; the renderer picks the recovery it offers from this. */
  readonly reason: AssistantUnavailableReason | null;
  /**
   * The failure's own words when there are any — dsh fails loud with one labelled line naming the
   * plugin that refused. Redacted before it gets here, and safe to show.
   */
  readonly detail: string | null;
  readonly providerKeys: AssistantProviderKeys;
  /** The absolute directory the agent's shell and filesystem are scoped to. */
  readonly workspaceRoot: string;
}

/** One choice inside a `select` configuration option, flattened out of its optional group. */
export interface AssistantOptionChoice {
  readonly value: string;
  readonly name: string;
  readonly description: string | null;
  /** The group heading dsh sent it under — the provider route, for the model option. */
  readonly group: string | null;
}

/**
 * A session configuration option as the renderer renders it. dsh publishes the complete option
 * state on every session creation, resume and change, so this is always the whole picture rather
 * than a delta — the model picker is drawn from it and nothing else.
 */
export interface AssistantOption {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly currentValue: string;
  readonly choices: readonly AssistantOptionChoice[];
}

/** An open conversation: its live session and the options that session admits. */
export interface AssistantSession {
  readonly conversationId: string;
  /**
   * How this session came to exist. `reused` is one already open in this run; `resumed` is one
   * rejoined from a previous run, and the UI says that out loud because ACP resume restores the
   * agent's context without replaying any of it — the chat looks empty and is not.
   */
  readonly origin: "created" | "reused" | "resumed";
  readonly options: readonly AssistantOption[];
}

/** The lifecycle of one tool call, as `tool_call` and `tool_call_update` report it. */
export type AssistantToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** One entry in a conversation's timeline. The renderer reduces these; main keeps the list. */
export type AssistantTimelineEntry =
  | { readonly kind: "user"; readonly id: string; readonly at: number; readonly text: string }
  | { readonly kind: "message"; readonly id: string; readonly at: number; readonly text: string }
  | { readonly kind: "thought"; readonly id: string; readonly at: number; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly at: number;
      readonly title: string;
      /** The tool's programmatic name when dsh sends one — `task_document_update_section`, `bash`. */
      readonly name: string | null;
      readonly status: AssistantToolStatus;
      /** Text the tool produced, concatenated; never raw input, which can hold anything. */
      readonly output: string;
    }
  | {
      readonly kind: "turn";
      readonly id: string;
      readonly at: number;
      readonly stopReason: AssistantStopReason;
    }
  | {
      readonly kind: "error";
      readonly id: string;
      readonly at: number;
      readonly reason: AssistantUnavailableReason;
      readonly detail: string | null;
    };

/** Why a turn ended. `cancelled` is the one the user caused. */
export type AssistantStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/** A pending approval: the agent is blocked until `assistantDecide` answers with an option id. */
export interface AssistantApproval {
  readonly requestId: string;
  readonly conversationId: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly name: string | null;
  readonly options: readonly {
    readonly optionId: string;
    readonly name: string;
    /** `allow_once`, `allow_always`, `reject_once`, `reject_always` — drives the button styling. */
    readonly kind: string;
  }[];
}

/** Everything main pushes to the renderer, tagged with the conversation it belongs to. */
export type AssistantEvent =
  | {
      readonly type: "timeline";
      readonly conversationId: string;
      readonly entry: AssistantTimelineEntry;
    }
  | {
      readonly type: "options";
      readonly conversationId: string;
      readonly options: readonly AssistantOption[];
    }
  | { readonly type: "approval"; readonly approval: AssistantApproval }
  | {
      readonly type: "approval_resolved";
      readonly conversationId: string;
      readonly requestId: string;
    }
  | { readonly type: "status"; readonly status: AssistantStatus };

/** The result of one turn. Failures arrive as a `reason`, never as a thrown string to parse. */
export interface AssistantTurnResult {
  readonly stopReason: AssistantStopReason | null;
  readonly reason: AssistantUnavailableReason | null;
  readonly detail: string | null;
}
