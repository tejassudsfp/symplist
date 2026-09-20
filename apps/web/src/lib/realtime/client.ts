import {
  type ClientFrame,
  type ConversationId,
  type TaskId,
  type Topic,
  userTopic,
  wsClientFrameRateLimit,
  wsCloseCodes,
  wsHeartbeatIntervalMs,
  wsPath,
} from "@symplist/contracts";
import { publicOrigins } from "../public-config.ts";
import {
  conversationSubscribeFrame,
  conversationTopic,
  type EventFrame,
  MAX_SUBSCRIPTIONS,
  type ParsedServerFrame,
  parseServerFrame,
  pingFrame,
  type SnapshotFrame,
  unsubscribeFrame,
  userSubscribeFrame,
} from "./frames.ts";

/** The browser socket surface the client uses (a fake implements it in tests). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type RealtimeStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "offline"
  | "closed"
  /** Session revoked or expired (close 4401); the app must return to sign-in. */
  | "unauthorized"
  /** Access lost (close 4403); the app must show the access gate. */
  | "forbidden";

export interface TopicHandlers {
  onEvent?(frame: EventFrame): void;
  onSnapshot?(frame: SnapshotFrame): void;
  /** The server asked for a resync: local state for the topic is stale until the next snapshot. */
  onResync?(): void;
  /** An `err` frame attributed to this subscription (for example `not_found`). */
  onError?(code: string): void;
}

export interface Subscription {
  readonly topic: Topic;
  unsubscribe(): void;
}

export interface UserSubscription extends Subscription {
  /**
   * Replaces the open task ids sent with the `user` subscription (at most 20). Throws a TypeError for
   * an id that is not a valid task id and a RangeError for more than 20 ids.
   */
  setOpenTasks(taskIds: readonly TaskId[]): void;
}

export interface RealtimeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RealtimeClientOptions {
  /** Full socket URL, for example `wss://api.example/v1/ws`. */
  readonly url: string;
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly timers?: RealtimeTimers;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** A connection open this long resets the backoff. */
  readonly stableAfterMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  /** Client frame budget, kept under the server's frame rate limit (§7). */
  readonly maxFramesPerWindow?: number;
  readonly frameWindowMs?: number;
  /** Online state and change notifications; defaults to `navigator.onLine` and window events. */
  readonly network?: {
    isOnline(): boolean;
    subscribe(onOnline: () => void): () => void;
  };
  readonly onStatus?: (status: RealtimeStatus) => void;
  /** `err` frames that could not be attributed to a subscription. */
  readonly onError?: (code: string) => void;
}

interface TopicEntry {
  readonly topic: Topic;
  readonly listeners: Set<TopicHandlers>;
  cursor: number | null;
  openTasks: readonly TaskId[];
  confirmed: boolean;
}

const OPEN = 1;
/** Client-side close codes; the gateway's own codes come from the contracts. */
const CLOSE_NORMAL = 1000;
const CLOSE_HEARTBEAT = 4000;
/** Session revoked or expired (`wsCloseCodes.sessionEnded`). */
export const CLOSE_UNAUTHORIZED = wsCloseCodes.sessionEnded;
/** Access lost (`wsCloseCodes.accessLost`). */
export const CLOSE_FORBIDDEN = wsCloseCodes.accessLost;

/** Pings ahead of the server's heartbeat interval so an idle but healthy socket stays open. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = wsHeartbeatIntervalMs - 5_000;
/** Leaves headroom under the server's limit for frames sent just before a window rolls over. */
const DEFAULT_MAX_FRAMES_PER_WINDOW = wsClientFrameRateLimit.frames - 4;

const browserTimers: RealtimeTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function browserNetwork(): NonNullable<RealtimeClientOptions["network"]> {
  return {
    isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    subscribe: (onOnline) => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener("online", onOnline);
      return () => window.removeEventListener("online", onOnline);
    },
  };
}

/**
 * The realtime client for `/v1/ws` (§7): topic subscriptions with cursors, jittered exponential
 * backoff with resubscription, an application heartbeat, frame-rate budgeting, and handling for
 * `resync`, `snapshot` and `err` frames. Commands never travel on the socket; they use HTTP.
 */
export class RealtimeClient {
  private socket: WebSocketLike | null = null;
  private statusValue: RealtimeStatus = "idle";
  private readonly topics = new Map<Topic, TopicEntry>();
  /** Topics whose `sub` was sent and that have not produced a frame yet (FIFO for `err`). */
  private unconfirmed: Topic[] = [];
  private queue: ClientFrame[] = [];
  private sentAt: number[] = [];
  private attempts = 0;
  private wanted = false;
  private reconnectTimer: unknown = null;
  private flushTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private heartbeatDeadline: unknown = null;
  private stableTimer: unknown = null;
  private unsubscribeNetwork: (() => void) | null = null;
  private readonly statusListeners = new Set<(status: RealtimeStatus) => void>();

  private readonly timers: RealtimeTimers;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly network: NonNullable<RealtimeClientOptions["network"]>;

  constructor(private readonly options: RealtimeClientOptions) {
    this.timers = options.timers ?? browserTimers;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.network = options.network ?? browserNetwork();
    if (options.onStatus) this.statusListeners.add(options.onStatus);
  }

  get status(): RealtimeStatus {
    return this.statusValue;
  }

  onStatusChange(listener: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** The last sequence number seen for a topic, used as the resubscribe cursor. */
  cursorOf(topic: Topic): number | null {
    return this.topics.get(topic)?.cursor ?? null;
  }

  connect(): void {
    this.wanted = true;
    if (this.statusValue === "unauthorized" || this.statusValue === "forbidden") {
      // A new sign-in or regained access explicitly reconnects.
      this.attempts = 0;
    }
    if (!this.unsubscribeNetwork) {
      this.unsubscribeNetwork = this.network.subscribe(() => this.handleOnline());
    }
    if (this.socket || this.reconnectTimer !== null) return;
    this.open();
  }

  /** Closes the socket and stops reconnecting. Subscriptions are kept for the next `connect()`. */
  disconnect(): void {
    this.wanted = false;
    this.clearTimers();
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      this.detach(socket);
      socket.close(CLOSE_NORMAL, "client disconnect");
    }
    this.queue = [];
    this.unconfirmed = [];
    this.setStatus("closed");
  }

  /**
   * Subscribes to the `user` topic. Open task ids are validated as UUIDv7 task ids (TypeError) and
   * limited to 20 (RangeError); repeated ids are sent once.
   */
  subscribeUser(openTasks: readonly TaskId[], handlers: TopicHandlers): UserSubscription {
    const frame = userSubscribeFrame(openTasks);
    const entry = this.addListener(userTopic, handlers);
    const changed = entry.openTasks.join(",") !== frame.openTasks.join(",");
    entry.openTasks = [...frame.openTasks];
    if (entry.listeners.size === 1 || changed) this.sendSubscribe(entry, frame);
    return {
      topic: userTopic,
      setOpenTasks: (taskIds) => {
        const next = userSubscribeFrame(taskIds);
        const current = this.topics.get(userTopic);
        if (!current?.listeners.has(handlers)) return;
        if (current.openTasks.join(",") === next.openTasks.join(",")) return;
        current.openTasks = [...next.openTasks];
        this.sendSubscribe(current, next);
      },
      unsubscribe: () => this.removeListener(userTopic, handlers),
    };
  }

  /** Subscribes to a conversation topic. Throws a TypeError when the id is not a valid UUIDv7. */
  subscribeConversation(conversationId: ConversationId, handlers: TopicHandlers): Subscription {
    const topic = conversationTopic(conversationId);
    const entry = this.addListener(topic, handlers);
    if (entry.listeners.size === 1) {
      this.sendSubscribe(entry, conversationSubscribeFrame(topic, entry.cursor));
    }
    return { topic, unsubscribe: () => this.removeListener(topic, handlers) };
  }

  private addListener(topic: Topic, handlers: TopicHandlers): TopicEntry {
    let entry = this.topics.get(topic);
    if (!entry) {
      if (this.topics.size >= MAX_SUBSCRIPTIONS) {
        throw new RangeError(`At most ${MAX_SUBSCRIPTIONS} realtime subscriptions`);
      }
      entry = { topic, listeners: new Set(), cursor: null, openTasks: [], confirmed: false };
      this.topics.set(topic, entry);
    }
    entry.listeners.add(handlers);
    return entry;
  }

  private removeListener(topic: Topic, handlers: TopicHandlers): void {
    const entry = this.topics.get(topic);
    if (!entry?.listeners.delete(handlers)) return;
    if (entry.listeners.size > 0) return;
    this.topics.delete(topic);
    this.unconfirmed = this.unconfirmed.filter((pending) => pending !== topic);
    this.queue = this.queue.filter((frame) => !("topic" in frame) || frame.topic !== topic);
    if (this.socket?.readyState === OPEN) this.enqueue(unsubscribeFrame(topic));
  }

  private sendSubscribe(entry: TopicEntry, frame: ClientFrame): void {
    entry.confirmed = false;
    // Coalesce: only the newest pending `sub` for a topic matters.
    this.queue = this.queue.filter(
      (queued) => !(queued.t === "sub" && queued.topic === entry.topic),
    );
    if (this.socket?.readyState !== OPEN) return;
    this.enqueue(frame);
  }

  private open(): void {
    if (!this.network.isOnline()) {
      this.setStatus("offline");
      return;
    }
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    let socket: WebSocketLike;
    try {
      socket = this.createSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.handleOpen(socket);
    socket.onmessage = (event) => this.handleMessage(socket, event);
    socket.onclose = (event) => this.handleClose(socket, event);
    socket.onerror = () => {
      // The close event that follows carries the outcome.
    };
  }

  private handleOpen(socket: WebSocketLike): void {
    if (socket !== this.socket) return;
    this.setStatus("open");
    this.queue = [];
    this.unconfirmed = [];
    for (const entry of this.topics.values()) {
      entry.confirmed = false;
      this.enqueue(
        entry.topic === userTopic
          ? userSubscribeFrame(entry.openTasks)
          : conversationSubscribeFrame(entry.topic, entry.cursor),
      );
    }
    this.scheduleHeartbeat();
    this.stableTimer = this.timers.setTimeout(() => {
      this.stableTimer = null;
      this.attempts = 0;
    }, this.options.stableAfterMs ?? 10_000);
  }

  private handleMessage(socket: WebSocketLike, event: MessageEvent): void {
    if (socket !== this.socket) return;
    this.clearHeartbeatDeadline();
    const frame = parseServerFrame(event.data);
    if (!frame) return;
    this.dispatchFrame(frame);
  }

  private dispatchFrame(frame: ParsedServerFrame): void {
    switch (frame.t) {
      case "pong":
        return;
      case "err": {
        const topic = this.unconfirmed.shift();
        const entry = topic ? this.topics.get(topic) : undefined;
        if (!entry) {
          this.options.onError?.(frame.code);
          return;
        }
        if (frame.code === "not_found" && entry.topic !== userTopic) {
          // Unknown and foreign conversations are indistinguishable; never resubscribe to them.
          this.topics.delete(entry.topic);
        }
        for (const listener of [...entry.listeners]) listener.onError?.(frame.code);
        return;
      }
      case "resync": {
        const entry = this.topics.get(frame.topic);
        if (!entry) return;
        entry.cursor = null;
        for (const listener of [...entry.listeners]) listener.onResync?.();
        this.sendSubscribe(
          entry,
          entry.topic === userTopic
            ? userSubscribeFrame(entry.openTasks)
            : conversationSubscribeFrame(entry.topic, null),
        );
        return;
      }
      case "snapshot": {
        const entry = this.confirm(frame.topic);
        if (!entry) return;
        entry.cursor = frame.seq;
        for (const listener of [...entry.listeners]) listener.onSnapshot?.(frame);
        return;
      }
      case "ev": {
        const entry = this.confirm(frame.topic);
        if (!entry) return;
        if (entry.cursor !== null && frame.seq <= entry.cursor) return; // replayed duplicate
        entry.cursor = frame.seq;
        for (const listener of [...entry.listeners]) listener.onEvent?.(frame);
        return;
      }
    }
  }

  private confirm(topic: Topic): TopicEntry | undefined {
    const entry = this.topics.get(topic);
    if (!entry) return undefined;
    if (!entry.confirmed) {
      entry.confirmed = true;
      this.unconfirmed = this.unconfirmed.filter((pending) => pending !== topic);
    }
    return entry;
  }

  private handleClose(socket: WebSocketLike, event: CloseEvent): void {
    if (socket !== this.socket) return;
    this.detach(socket);
    this.socket = null;
    this.clearTimers();
    this.queue = [];
    this.unconfirmed = [];
    if (event.code === CLOSE_UNAUTHORIZED) {
      this.wanted = false;
      this.setStatus("unauthorized");
      return;
    }
    if (event.code === CLOSE_FORBIDDEN) {
      this.wanted = false;
      this.setStatus("forbidden");
      return;
    }
    if (!this.wanted) {
      this.setStatus("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.network.isOnline()) {
      this.setStatus("offline");
      return;
    }
    const initial = this.options.initialBackoffMs ?? 500;
    const max = this.options.maxBackoffMs ?? 30_000;
    const cap = Math.min(max, initial * 2 ** this.attempts);
    // Equal jitter: never zero, spread across [cap/2, cap).
    const delay = cap / 2 + this.random() * (cap / 2);
    this.attempts += 1;
    this.setStatus("reconnecting");
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted) this.open();
    }, delay);
  }

  private handleOnline(): void {
    if (!this.wanted || this.socket) return;
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempts = 0;
    this.open();
  }

  private scheduleHeartbeat(): void {
    const interval = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = this.timers.setTimeout(() => {
      this.heartbeatTimer = null;
      const socket = this.socket;
      if (!socket || socket.readyState !== OPEN) return;
      this.enqueue(pingFrame);
      if (this.heartbeatDeadline === null) {
        this.heartbeatDeadline = this.timers.setTimeout(() => {
          this.heartbeatDeadline = null;
          if (this.socket !== socket) return;
          // No frame arrived in time: treat the socket as dead and reconnect.
          socket.close(CLOSE_HEARTBEAT, "heartbeat timeout");
          this.handleClose(socket, { code: CLOSE_HEARTBEAT } as CloseEvent);
        }, this.options.heartbeatTimeoutMs ?? 10_000);
      }
      this.scheduleHeartbeat();
    }, interval);
  }

  private clearHeartbeatDeadline(): void {
    if (this.heartbeatDeadline !== null) {
      this.timers.clearTimeout(this.heartbeatDeadline);
      this.heartbeatDeadline = null;
    }
  }

  private enqueue(frame: ClientFrame): void {
    this.queue.push(frame);
    this.flush();
  }

  private flush(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    const windowMs = this.options.frameWindowMs ?? wsClientFrameRateLimit.windowMs;
    const budget = this.options.maxFramesPerWindow ?? DEFAULT_MAX_FRAMES_PER_WINDOW;
    while (this.queue.length > 0) {
      const now = this.now();
      this.sentAt = this.sentAt.filter((time) => now - time < windowMs);
      if (this.sentAt.length >= budget) {
        if (this.flushTimer === null) {
          const wait = windowMs - (now - (this.sentAt[0] ?? now));
          this.flushTimer = this.timers.setTimeout(
            () => {
              this.flushTimer = null;
              this.flush();
            },
            Math.max(1, wait),
          );
        }
        return;
      }
      const frame = this.queue.shift() as ClientFrame;
      if (frame.t === "sub") this.unconfirmed.push(frame.topic);
      socket.send(JSON.stringify(frame));
      this.sentAt.push(now);
    }
  }

  private detach(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private clearTimers(): void {
    for (const key of [
      "reconnectTimer",
      "flushTimer",
      "heartbeatTimer",
      "heartbeatDeadline",
      "stableTimer",
    ] as const) {
      if (this[key] !== null) {
        this.timers.clearTimeout(this[key]);
        this[key] = null;
      }
    }
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

/** The socket URL for the configured public WebSocket origin, or null when it is not configured. */
export function realtimeUrl(): string | null {
  const { wsOrigin } = publicOrigins();
  return wsOrigin ? `${wsOrigin}${wsPath}` : null;
}
