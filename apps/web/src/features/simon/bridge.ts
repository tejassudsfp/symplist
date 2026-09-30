import type { AcpPermissionRequest, AcpStopReason } from "@symplist/contracts";

/**
 * The only file in `apps/web` that touches `window.symplist`.
 *
 * Everything else in this feature takes a `ChatBridge` as an argument, so the whole chat UI is
 * testable against a plain object and the desktop-only surface is one import away from the rest of the
 * app. The type is matched structurally rather than imported from `@symplist/desktop`: the web app is
 * deployed to a browser that has no bridge at all and must not depend on the Electron package.
 *
 * Mounting is decided by capability detection, never by a build flag. A flag has a wrong setting that
 * ships a chat pane to the cloud, where there is no harness to answer it; a missing preload script
 * cannot be set wrongly. `hasDesktopChat()` is that detection, and it also insists the shell has told
 * us the harness is actually running — a desktop with a broken dsh child shows no chat rather than a
 * chat that can never reply.
 */

/** One assistant turn's input. Images are out of scope for phase 2; text and file references are not. */
export type ChatPromptBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resource_link"; readonly uri: string; readonly name: string };

/** A conversation the shell knows about, whether or not its harness session is still alive. */
export interface ChatConversationSummary {
  readonly conversationId: string;
  /** The absolute directory the harness session is pinned to. ACP allows exactly one per session. */
  readonly cwd: string;
  readonly taskId: string | null;
  readonly title: string | null;
  readonly updatedAt: number;
  /**
   * Whether the harness can resume this conversation's session. False means the transcript replays from
   * our own store and the next prompt starts a fresh session, so the agent will not remember the earlier
   * turns — which the pane says out loud rather than letting the person discover it.
   */
  readonly resumable: boolean;
}

/** A conversation opened and ready to prompt. */
export interface ChatSession {
  readonly conversationId: string;
  readonly cwd: string;
  /**
   * Whether a fresh harness session was started because the previous one could not be resumed. The pane
   * draws a divider at that point in the transcript.
   */
  readonly memoryReset: boolean;
}

/** One stored row, exactly as it went over the wire, plus its place in the conversation. */
export interface ChatStoredUpdate {
  readonly seq: number;
  readonly receivedAt: number;
  /** The raw ACP `update` object. Parsed by the projection, never by the bridge. */
  readonly update: unknown;
}

/** A page of history, newest-last, with the cursor to ask for what came before it. */
export interface ChatHistoryPage {
  readonly updates: readonly ChatStoredUpdate[];
  readonly nextBeforeSeq: number | null;
}

/**
 * What arrives from main while a conversation is open. Only `update` is ACP; the rest are the few
 * things the JSON-RPC client knows and the notification stream does not carry.
 */
export type ChatBridgeEvent =
  | { readonly type: "update"; readonly seq: number; readonly update: unknown }
  | { readonly type: "permission"; readonly request: AcpPermissionRequest }
  | { readonly type: "permission_settled"; readonly requestId: string }
  | { readonly type: "turn_started" }
  | { readonly type: "turn_ended"; readonly stopReason: AcpStopReason }
  /**
   * The prompt was refused outright — a rejected `session/prompt`, a dead harness, a missing model
   * credential. This is the only place a failure can be told apart from a clean finish: `dsh-acp` maps
   * the harness's `error` and `blocked` endings onto `end_turn`, so a stop reason cannot carry it.
   */
  | { readonly type: "failed"; readonly code: string; readonly message: string };

/**
 * The desktop chat capability, as the renderer sees it.
 *
 * Every method is one IPC call to the Electron main process, which owns the ACP connection, the dsh
 * child and the transcript file. Nothing here returns a credential, and nothing here accepts one: the
 * model key lives in the OS keychain and is read in main by the process about to call the provider.
 */
export interface ChatBridge {
  /** The conversations the shell has, newest first. */
  list(): Promise<readonly ChatConversationSummary[]>;
  /**
   * Opens a conversation, resuming its harness session when it can. `cwd` must be absolute and is
   * remembered: a conversation owns its directory, because an ACP session pins exactly one and
   * "additional directories remain unsupported".
   */
  start(input: {
    readonly conversationId?: string;
    readonly taskId: string | null;
    readonly cwd: string;
  }): Promise<ChatSession>;
  /** Sends one turn. ACP permits exactly one prompt in flight per session. */
  prompt(conversationId: string, blocks: readonly ChatPromptBlock[]): Promise<void>;
  /** Cancels the turn in flight. Main must also answer any outstanding permission with `cancelled`. */
  cancel(conversationId: string): Promise<void>;
  /** Answers a `session/request_permission`. `"cancelled"` is ACP's own no-choice outcome. */
  answerPermission(requestId: string, optionId: string | "cancelled"): Promise<void>;
  /** Changes an advertised session option, such as the model route. Applies to the next turn. */
  setConfig(conversationId: string, id: string, value: string | boolean): Promise<void>;
  /** A page of stored updates ending before `beforeSeq`, or the newest page when it is null. */
  history(conversationId: string, beforeSeq: number | null): Promise<ChatHistoryPage>;
  /** Live events for an open conversation. Returns the unsubscribe function. */
  subscribe(conversationId: string, listener: (event: ChatBridgeEvent) => void): () => void;
  /** Whether a directory exists and may be used as a conversation's workspace. */
  chooseDirectory(): Promise<string | null>;
}

interface BridgeHost {
  readonly chat?: ChatBridge;
  readonly host?: { info(): Promise<{ readonly assistant?: boolean }> };
}

function host(): BridgeHost | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { symplist?: BridgeHost }).symplist;
}

/**
 * The chat bridge, or null in a browser. Reading it through a function rather than a module constant
 * matters: the preload script has run long before any React code, but a test that installs a fake needs
 * the lookup to happen at call time.
 */
export function chatBridge(): ChatBridge | null {
  return host()?.chat ?? null;
}

/** Whether this runtime can host the chat pane at all. */
export function hasDesktopChat(): boolean {
  return chatBridge() !== null;
}

/**
 * Whether the harness is actually running, which is a second question from whether the bridge exists.
 * The shell answers `assistant: false` when the dsh child failed to start, and the chat slot stays
 * empty on that rather than mounting a pane whose every prompt would fail.
 */
export async function desktopAssistantReady(): Promise<boolean> {
  const bridge = host();
  if (!bridge?.chat) return false;
  try {
    return (await bridge.host?.info())?.assistant === true;
  } catch {
    // An IPC failure here is indistinguishable from a shell without the capability, and the safe
    // reading of both is the same: do not offer a chat that cannot answer.
    return false;
  }
}
