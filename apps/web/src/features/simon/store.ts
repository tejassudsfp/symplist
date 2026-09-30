import type {
  ChatBridge,
  ChatBridgeEvent,
  ChatConversationSummary,
  ChatPromptBlock,
  ChatSession,
} from "./bridge.ts";
import {
  type ChatEvent,
  type ChatProjection,
  emptyChatProjection,
  reduceChat,
} from "./projection.ts";

/**
 * The chat feature's state, one entry per conversation, held outside React.
 *
 * It exists for the same reason the cloud chat's store did: a conversation must survive the panel being
 * unmounted — switching tasks, collapsing the pane, navigating away — and a component's state cannot.
 * What is different is where the truth lives. There is no server to reload from; the Electron main
 * process holds the transcript, and this store is a cache of the projection plus the handful of things
 * only the person's current screen knows.
 *
 * Two invariants are the reason this file is worth testing before any component exists:
 *
 * 1. **One prompt in flight per conversation.** ACP admits exactly one, and `dsh-acp` says so:
 *    "one prompt at a time per session". Send is hard-disabled while one is running, rather than queued
 *    — a queue would be a promise this transport cannot keep.
 * 2. **Cancelling answers an outstanding permission request.** If a turn is cancelled while the harness
 *    is blocked on `session/request_permission`, and nothing answers it, the harness waits forever. The
 *    answer is ACP's own `cancelled` outcome, and it is sent *before* the cancel, because after the
 *    cancel there may be nothing left listening for it.
 *
 * Drafts live here and only here. They never enter browser persistence: a half-written message to an
 * assistant that can run commands is exactly the sort of thing that should not outlive the window.
 */

/** How a conversation's session stands. */
export type ChatPhase =
  /** No session yet — the pane is asking for a project folder. */
  | "setup"
  | "opening"
  | "idle"
  | "working"
  /** The harness is blocked on a permission request; the composer waits with it. */
  | "awaiting_permission";

export interface ChatState {
  readonly conversationId: string | null;
  readonly taskId: string | null;
  readonly cwd: string | null;
  readonly phase: ChatPhase;
  readonly projection: ChatProjection;
  readonly draft: string;
  readonly loadingHistory: boolean;
  readonly nextBeforeSeq: number | null;
  /** A failure worth showing, with its code so the pane can say something specific about it. */
  readonly failure: { readonly code: string; readonly message: string } | null;
  /** True once a cancel has been asked for and before the turn has ended. */
  readonly stopping: boolean;
}

const blankState: ChatState = {
  conversationId: null,
  taskId: null,
  cwd: null,
  phase: "setup",
  projection: emptyChatProjection,
  draft: "",
  loadingHistory: false,
  nextBeforeSeq: null,
  failure: null,
  stopping: false,
};

/**
 * Whether the composer may send. The `phase` check is the ACP one-prompt rule; the rest is the ordinary
 * "there is something to send and somewhere to send it".
 */
export function canSendChat(state: ChatState): boolean {
  return state.phase === "idle" && state.conversationId !== null && state.draft.trim().length > 0;
}

/** Whether the composer may cancel: there is a turn to cancel and we have not already asked. */
export function canCancelChat(state: ChatState): boolean {
  return (
    (state.phase === "working" || state.phase === "awaiting_permission") &&
    !state.stopping &&
    state.conversationId !== null
  );
}

interface Entry {
  state: ChatState;
  watchers: number;
  unsubscribe: (() => void) | null;
  /** How many user turns have been recorded, so a local user item gets a stable id. */
  turns: number;
}

/** The key an entry is filed under: a task's conversation, or the workspace-wide one. */
function keyOf(taskId: string | null): string {
  return taskId ?? "__workspace__";
}

export class ChatStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  /** Cached `list()` answer, so opening the pane does not re-ask on every mount. */
  private conversations: readonly ChatConversationSummary[] | null = null;

  constructor(readonly bridge: ChatBridge) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The state for a conversation. Stable between changes, so `useSyncExternalStore` is happy. */
  get(taskId: string | null): ChatState {
    return this.entries.get(keyOf(taskId))?.state ?? { ...blankState, taskId };
  }

  private entry(taskId: string | null): Entry {
    const key = keyOf(taskId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const created: Entry = {
      state: { ...blankState, taskId },
      watchers: 0,
      unsubscribe: null,
      turns: 0,
    };
    this.entries.set(key, created);
    return created;
  }

  private set(taskId: string | null, change: Partial<ChatState>): void {
    const entry = this.entry(taskId);
    entry.state = { ...entry.state, ...change };
    this.emit();
  }

  private fold(taskId: string | null, event: ChatEvent): void {
    const entry = this.entry(taskId);
    entry.state = { ...entry.state, projection: reduceChat(entry.state.projection, event) };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Mounts a view of a conversation. Returns the release function, and keeps the subscription open while
   * any view still holds it — the pane and a mobile surface can both be mounted over one conversation,
   * and the second one must not tear down the first one's stream.
   */
  watch(taskId: string | null): () => void {
    const entry = this.entry(taskId);
    entry.watchers += 1;
    const id = entry.state.conversationId;
    if (id && !entry.unsubscribe) entry.unsubscribe = this.listen(taskId, id);
    return () => {
      entry.watchers -= 1;
      if (entry.watchers > 0) return;
      entry.unsubscribe?.();
      entry.unsubscribe = null;
    };
  }

  private listen(taskId: string | null, conversationId: string): () => void {
    return this.bridge.subscribe(conversationId, (event) => this.receive(taskId, event));
  }

  /** One live event from main. */
  private receive(taskId: string | null, event: ChatBridgeEvent): void {
    switch (event.type) {
      case "update":
        this.fold(taskId, { type: "update", update: event.update });
        return;
      case "permission":
        this.fold(taskId, { type: "permission", request: event.request });
        this.set(taskId, { phase: "awaiting_permission" });
        return;
      case "permission_settled":
        this.fold(taskId, { type: "permission_settled" });
        // Back to working: the harness resumes the turn the moment it has an answer.
        if (this.get(taskId).phase === "awaiting_permission")
          this.set(taskId, { phase: "working" });
        return;
      case "turn_started":
        this.fold(taskId, { type: "turn_started" });
        this.set(taskId, { phase: "working", failure: null, stopping: false });
        return;
      case "turn_ended":
        this.fold(taskId, { type: "turn_ended", stopReason: event.stopReason });
        this.set(taskId, { phase: "idle", stopping: false });
        return;
      case "failed":
        this.set(taskId, {
          phase: "idle",
          stopping: false,
          failure: { code: event.code, message: event.message },
        });
        return;
    }
  }

  /** The shell's conversations, read once and remembered. */
  async conversationList(): Promise<readonly ChatConversationSummary[]> {
    if (this.conversations) return this.conversations;
    const list = await this.bridge.list();
    this.conversations = list;
    return list;
  }

  /** Forgets the cached list, so the next read is fresh. */
  forgetConversationList(): void {
    this.conversations = null;
  }

  /**
   * Opens a conversation in a project folder, replays its stored transcript and starts listening.
   *
   * A conversation owns its directory for good: an ACP session pins one absolute `cwd` and cannot be
   * given a second, so changing it would mean a different session and a different agent memory. The
   * folder is asked for once and remembered.
   */
  async open(
    taskId: string | null,
    input: { readonly conversationId?: string; readonly cwd: string },
  ): Promise<void> {
    const entry = this.entry(taskId);
    this.set(taskId, { phase: "opening", failure: null });
    let session: ChatSession;
    try {
      session = await this.bridge.start({
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        taskId,
        cwd: input.cwd,
      });
    } catch (error) {
      this.set(taskId, { phase: "setup", failure: describeFailure(error) });
      return;
    }
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    entry.state = {
      ...entry.state,
      conversationId: session.conversationId,
      cwd: session.cwd,
      projection: emptyChatProjection,
      nextBeforeSeq: null,
      phase: "idle",
    };
    this.emit();
    await this.replayHistory(taskId, session.conversationId, session.memoryReset);
    if (entry.watchers > 0 && !entry.unsubscribe)
      entry.unsubscribe = this.listen(taskId, session.conversationId);
    this.forgetConversationList();
  }

  /**
   * Replays the newest page of stored updates through the same reducer the live path uses. The order
   * matters: the memory-reset divider is folded last, so it marks the end of what the agent has
   * forgotten rather than the start.
   */
  private async replayHistory(
    taskId: string | null,
    conversationId: string,
    memoryReset: boolean,
  ): Promise<void> {
    this.set(taskId, { loadingHistory: true });
    try {
      const page = await this.bridge.history(conversationId, null);
      const entry = this.entry(taskId);
      let projection = emptyChatProjection;
      for (const row of page.updates)
        projection = reduceChat(projection, { type: "update", update: row.update });
      if (memoryReset) projection = reduceChat(projection, { type: "memory_reset" });
      entry.state = { ...entry.state, projection, nextBeforeSeq: page.nextBeforeSeq };
      this.emit();
    } catch (error) {
      this.set(taskId, { failure: describeFailure(error) });
    } finally {
      this.set(taskId, { loadingHistory: false });
    }
  }

  /** Prepends the page of stored updates before the oldest one on screen. */
  async loadOlder(taskId: string | null): Promise<void> {
    const state = this.get(taskId);
    if (!state.conversationId || state.nextBeforeSeq === null || state.loadingHistory) return;
    this.set(taskId, { loadingHistory: true });
    try {
      const page = await this.bridge.history(state.conversationId, state.nextBeforeSeq);
      const entry = this.entry(taskId);
      // Older rows are folded into a fresh projection and the newer items appended after it, because the
      // reducer is a fold from the beginning and cannot be run backwards.
      let older = emptyChatProjection;
      for (const row of page.updates)
        older = reduceChat(older, { type: "update", update: row.update });
      entry.state = {
        ...entry.state,
        projection: {
          ...entry.state.projection,
          items: [...older.items, ...entry.state.projection.items],
        },
        nextBeforeSeq: page.nextBeforeSeq,
      };
      this.emit();
    } catch (error) {
      this.set(taskId, { failure: describeFailure(error) });
    } finally {
      this.set(taskId, { loadingHistory: false });
    }
  }

  draft(taskId: string | null, value: string): void {
    this.set(taskId, { draft: value });
  }

  /**
   * Sends the draft as one turn.
   *
   * The user's own message is added locally, because the harness does not echo prompts back on the
   * notification stream. The phase moves to `working` before the call rather than after it: the send
   * button must be dead the instant it is pressed, or a second press lands a second prompt on a session
   * that admits one.
   */
  async send(taskId: string | null): Promise<void> {
    const state = this.get(taskId);
    if (!canSendChat(state) || !state.conversationId) return;
    const text = state.draft.trim();
    const entry = this.entry(taskId);
    entry.turns += 1;
    this.fold(taskId, { type: "user", id: `local:${entry.turns}`, text });
    this.set(taskId, { draft: "", phase: "working", failure: null, stopping: false });
    const blocks: readonly ChatPromptBlock[] = [{ type: "text", text }];
    try {
      await this.bridge.prompt(state.conversationId, blocks);
    } catch (error) {
      // The turn never started, so nothing will end it: the phase has to be released here.
      this.set(taskId, { phase: "idle", failure: describeFailure(error) });
    }
  }

  /**
   * Cancels the turn in flight.
   *
   * The outstanding permission request is answered first. `session/cancel` does not resolve a
   * `session/request_permission` the harness is already blocked on, so cancelling without answering it
   * leaves the agent parked on a question nobody will ever answer — and that is a hang with no error and
   * no log, which is the worst kind.
   */
  async cancel(taskId: string | null): Promise<void> {
    const state = this.get(taskId);
    if (!canCancelChat(state) || !state.conversationId) return;
    this.set(taskId, { stopping: true });
    const pending = state.projection.pendingPermission;
    try {
      if (pending) {
        await this.bridge.answerPermission(pending.requestId, "cancelled");
        this.fold(taskId, { type: "permission_settled" });
      }
      await this.bridge.cancel(state.conversationId);
    } catch (error) {
      this.set(taskId, { stopping: false, failure: describeFailure(error) });
    }
  }

  /** Answers the permission request on screen. */
  async answerPermission(taskId: string | null, optionId: string | "cancelled"): Promise<void> {
    const state = this.get(taskId);
    const pending = state.projection.pendingPermission;
    if (!pending) return;
    this.fold(taskId, { type: "permission_settled" });
    this.set(taskId, { phase: "working" });
    try {
      await this.bridge.answerPermission(pending.requestId, optionId);
    } catch (error) {
      this.set(taskId, { failure: describeFailure(error) });
    }
  }

  /** Changes a session option, such as the model route. It applies to the next turn, not this one. */
  async setConfig(taskId: string | null, id: string, value: string | boolean): Promise<void> {
    const state = this.get(taskId);
    if (!state.conversationId) return;
    try {
      await this.bridge.setConfig(state.conversationId, id, value);
    } catch (error) {
      this.set(taskId, { failure: describeFailure(error) });
    }
  }

  /** Clears a failure the person has read. */
  dismissFailure(taskId: string | null): void {
    this.set(taskId, { failure: null });
  }

  /** Releases every subscription. Called when the provider unmounts. */
  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.unsubscribe?.();
      entry.unsubscribe = null;
      entry.watchers = 0;
    }
  }
}

/**
 * A failure in the words the pane will show. The bridge rejects with an `Error` whose message main
 * already made presentable; anything else gets a sentence that does not pretend to know more.
 */
export function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : "chat.failed",
      message: error.message || "Simon could not complete that.",
    };
  }
  return { code: "chat.failed", message: "Simon could not complete that." };
}
