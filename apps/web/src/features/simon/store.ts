import type {
  simonApprovalViewSchema,
  simonAskViewSchema,
  simonMessageInputSchema,
} from "@symplist/contracts";
import { ApiError, createIdempotencyKey } from "@/lib/api";
import type { RealtimeStatus } from "@/lib/realtime";
import { type SimonApi, simonErrorMessage } from "./api.ts";
import {
  type ChatProjection,
  emptyProjection,
  projectEvent,
  projectSnapshot,
  retainOlder,
} from "./projection.ts";
import type { SimonRealtime } from "./realtime.ts";

export interface ChatState {
  readonly taskId: string | null;
  readonly conversationId: string | null;
  readonly projection: ChatProjection;
  readonly draft: string;
  readonly tier: "fast" | "smart";
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly uncertain: boolean;
  readonly connection: RealtimeStatus;
  readonly approval: typeof simonApprovalViewSchema._output | null;
  readonly ask: typeof simonAskViewSchema._output | null;
}
interface Pending {
  readonly key: string;
  readonly perform: (idempotencyKey: string) => Promise<unknown>;
  readonly confirmed?: () => void;
}
interface Entry {
  state: ChatState;
  readonly createKey: string;
  watchers: number;
  reading: boolean;
  refreshAgain: boolean;
  readVersion: number;
  off: (() => void) | null;
  pending: Pending | null;
}
const quickKey = "quick";

export function canSendChat(state: ChatState): boolean {
  const view = state.projection.view;
  return !!(
    state.conversationId &&
    view &&
    state.draft.trim() &&
    !state.busy &&
    !state.uncertain &&
    (!view.pendingAskId || state.ask?.id === view.pendingAskId)
  );
}

/** Owner-scoped memory only: drafts survive navigation, never enter browser persistence. */
export class SimonStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  constructor(
    readonly api: SimonApi,
    readonly realtime: SimonRealtime | null,
  ) {}
  private entry(taskId: string | null): Entry {
    const key = taskId ?? quickKey;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        createKey: createIdempotencyKey(),
        watchers: 0,
        reading: false,
        refreshAgain: false,
        readVersion: 0,
        off: null,
        pending: null,
        state: {
          taskId,
          conversationId: null,
          projection: emptyProjection,
          draft: "",
          tier: "fast",
          loading: false,
          loadingOlder: false,
          busy: false,
          error: null,
          uncertain: false,
          connection: "idle",
          approval: null,
          ask: null,
        },
      };
      this.entries.set(key, entry);
    }
    return entry;
  }
  get = (taskId: string | null): ChatState => this.entry(taskId).state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(entry: Entry, patch: Partial<ChatState>) {
    entry.state = { ...entry.state, ...patch };
    if (!this.disposed) for (const listener of this.listeners) listener();
  }
  reopen() {
    if (!this.disposed) return;
    this.disposed = false;
    for (const entry of this.entries.values())
      if (entry.watchers) void this.load(entry.state.taskId);
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    for (const entry of this.entries.values()) {
      entry.off?.();
      entry.off = null;
      entry.reading = false;
      entry.refreshAgain = false;
      this.update(entry, {
        loading: false,
        loadingOlder: false,
        busy: false,
        ...(entry.pending
          ? {
              uncertain: true,
              error: "This request was interrupted. Retry the same request to confirm its outcome.",
            }
          : {}),
      });
    }
  }
  watch(taskId: string | null) {
    const entry = this.entry(taskId);
    entry.watchers++;
    if (!this.disposed) void this.load(taskId);
    return () => {
      entry.watchers = Math.max(0, entry.watchers - 1);
      if (!entry.watchers) {
        entry.off?.();
        entry.off = null;
        entry.readVersion++;
        entry.reading = false;
        this.update(entry, {
          projection: emptyProjection,
          approval: null,
          ask: null,
          loading: false,
          loadingOlder: false,
        });
      }
    };
  }
  draft(taskId: string | null, value: string) {
    const entry = this.entry(taskId);
    if (!entry.pending) this.update(entry, { draft: value.slice(0, 32000) });
  }
  tier(taskId: string | null, tier: "fast" | "smart") {
    const entry = this.entry(taskId);
    if (!entry.pending) this.update(entry, { tier });
  }
  async load(taskId: string | null) {
    const entry = this.entry(taskId);
    if (this.disposed || !entry.watchers) return;
    if (entry.reading) {
      entry.refreshAgain = true;
      return;
    }
    entry.reading = true;
    const version = ++entry.readVersion;
    const generation = this.generation;
    const current = () =>
      !this.disposed &&
      generation === this.generation &&
      version === entry.readVersion &&
      entry.watchers > 0;
    this.update(entry, { loading: !entry.state.projection.view });
    try {
      const id =
        entry.state.conversationId ??
        (await this.api.create(taskId, entry.createKey)).conversationId;
      if (!current()) return;
      this.update(entry, { conversationId: id });
      // Subscribe after the initial HTTP snapshot, so an older HTTP reply cannot overwrite events.
      const cursor = entry.state.projection.cursor;
      const view = await this.api.history(id);
      if (!current()) return;
      if (entry.state.projection.cursor !== cursor) {
        entry.refreshAgain = true;
        return;
      }
      this.update(entry, {
        projection: {
          ...entry.state.projection,
          view: retainOlder(entry.state.projection.view, view),
          live:
            view.activeRun?.runId === entry.state.projection.live?.runId
              ? entry.state.projection.live
              : null,
        },
        loading: false,
        ...(!entry.pending ? { error: null } : {}),
      });
      await this.pauses(entry, current);
      if (!current()) return;
      if (!entry.off && this.realtime)
        entry.off = this.realtime.subscribe(
          id,
          {
            onSnapshot: (frame) => {
              if (this.disposed || !entry.watchers || generation !== this.generation) return;
              this.update(entry, {
                projection: projectSnapshot(entry.state.projection, id, frame.seq, frame.data),
                loading: false,
              });
              void this.pauses(
                entry,
                () => !this.disposed && generation === this.generation && entry.watchers > 0,
              );
            },
            onEvent: (frame) => {
              if (this.disposed || !entry.watchers || generation !== this.generation) return;
              const previous = entry.state.projection;
              const projection = projectEvent(previous, frame);
              this.update(entry, { projection });
              if (frame.type !== "chunk" || (projection.live?.ended && !previous.live?.ended))
                void this.load(taskId);
            },
            onResync: () => {
              if (generation === this.generation) void this.load(taskId);
            },
            onError: () => {
              if (generation !== this.generation || this.disposed) return;
              this.update(entry, {
                projection: emptyProjection,
                approval: null,
                ask: null,
                error: "This conversation is no longer available.",
              });
            },
          },
          (connection) => {
            if (this.disposed || generation !== this.generation || !entry.watchers) return;
            this.update(entry, {
              connection,
              ...(connection === "unauthorized" || connection === "forbidden"
                ? { projection: emptyProjection, approval: null, ask: null, draft: "" }
                : {}),
            });
          },
        );
    } catch (error) {
      if (current())
        this.update(entry, {
          loading: false,
          error: simonErrorMessage(error),
          ...(error instanceof ApiError && [401, 403, 404].includes(error.status)
            ? { projection: emptyProjection, approval: null, ask: null }
            : {}),
        });
    } finally {
      if (current()) {
        entry.reading = false;
        if (entry.refreshAgain) {
          entry.refreshAgain = false;
          void this.load(taskId);
        }
      }
    }
  }
  private async pauses(entry: Entry, current: () => boolean) {
    const view = entry.state.projection.view;
    if (!view) return;
    const approvalId = view.pendingApprovalId;
    const askId = view.pendingAskId;
    const stillCurrent = () =>
      current() &&
      entry.state.projection.view?.pendingApprovalId === approvalId &&
      entry.state.projection.view?.pendingAskId === askId;
    try {
      const [approval, ask] = await Promise.all([
        approvalId ? this.api.approval(approvalId) : null,
        askId ? this.api.ask(askId) : null,
      ]);
      if (stillCurrent()) this.update(entry, { approval, ask });
    } catch (error) {
      if (stillCurrent())
        this.update(entry, { error: simonErrorMessage(error), approval: null, ask: null });
    }
  }
  async loadOlder(taskId: string | null) {
    const entry = this.entry(taskId);
    const view = entry.state.projection.view;
    const before = view?.nextBeforeSeq;
    if (!view || before == null || entry.state.loadingOlder || this.disposed || !entry.watchers)
      return;
    const generation = this.generation;
    const version = entry.readVersion;
    const current = () =>
      !this.disposed &&
      generation === this.generation &&
      entry.watchers > 0 &&
      version === entry.readVersion;
    this.update(entry, { loadingOlder: true });
    try {
      const page = await this.api.history(view.conversationId, before);
      if (!current()) return;
      const head = entry.state.projection.view;
      if (!head || head.conversationId !== page.conversationId) return;
      const messages = new Map(head.messages.map((message) => [message.id, message]));
      for (const message of page.messages)
        if (!messages.has(message.id)) messages.set(message.id, message);
      this.update(entry, {
        projection: {
          ...entry.state.projection,
          view: {
            ...head,
            messages: [...messages.values()].sort((a, b) => a.seq - b.seq),
            nextBeforeSeq: page.nextBeforeSeq,
          },
        },
      });
    } catch (error) {
      if (current()) this.update(entry, { error: simonErrorMessage(error) });
    } finally {
      if (generation === this.generation) this.update(entry, { loadingOlder: false });
    }
  }
  async command(taskId: string | null, perform: Pending["perform"], confirmed?: () => void) {
    const entry = this.entry(taskId);
    if (entry.pending || entry.state.busy || this.disposed) return false;
    entry.pending = { key: createIdempotencyKey(), perform, ...(confirmed ? { confirmed } : {}) };
    return this.retryRequest(taskId);
  }
  async retryRequest(taskId: string | null) {
    const entry = this.entry(taskId);
    const pending = entry.pending;
    if (!pending || entry.state.busy || this.disposed) return false;
    const generation = this.generation;
    this.update(entry, { busy: true, error: null, uncertain: false });
    try {
      await pending.perform(pending.key);
      if (generation !== this.generation || this.disposed) return false;
      entry.pending = null;
      pending.confirmed?.();
      this.update(entry, { busy: false, uncertain: false });
      if (this.entries.get(taskId ?? quickKey) === entry) void this.load(taskId);
      return true;
    } catch (error) {
      if (generation !== this.generation || this.disposed) return false;
      const definitive =
        error instanceof ApiError && error.status < 500 && ![408, 409, 429].includes(error.status);
      if (definitive) entry.pending = null;
      this.update(entry, { busy: false, uncertain: !definitive, error: simonErrorMessage(error) });
      return false;
    }
  }
  send(taskId: string | null) {
    const entry = this.entry(taskId);
    const { conversationId, draft, tier, ask } = entry.state;
    if (!conversationId || !canSendChat(entry.state)) return Promise.resolve(false);
    const body: typeof simonMessageInputSchema._output = { text: draft.trim(), tier };
    return this.command(
      taskId,
      (key) =>
        ask?.status === "pending"
          ? this.api.answer(ask.id, body.text, key)
          : this.api.send(conversationId, body, key),
      () => this.update(entry, { draft: "" }),
    );
  }
  forgetQuick() {
    const entry = this.entries.get(quickKey);
    entry?.off?.();
    if (entry) {
      entry.watchers = 0;
      entry.readVersion++;
    }
    this.entries.delete(quickKey);
    for (const listener of this.listeners) listener();
  }
  closeQuick(confirmed: () => void) {
    const entry = this.entry(null);
    return this.command(
      null,
      async (key) => {
        // A lost creation response is resolved with its original key before deletion.
        const id =
          entry.state.conversationId ??
          (await this.api.create(null, entry.createKey)).conversationId;
        this.update(entry, { conversationId: id });
        return this.api.close(id, key);
      },
      () => {
        this.forgetQuick();
        confirmed();
      },
    );
  }
}
