import {
  type AccessState,
  isStableCode,
  isUserTopicEventType,
  parseTopic,
  type Topic,
  type UserTopicSnapshot,
  unadmittedUserTopicEventTypes,
  userTopic,
  userTopicSnapshotSchema,
  wsCloseCodes,
  wsEvents,
  wsMaxSubscriptions,
} from "@symplist/contracts";
import type { AccessService, SessionContext } from "@symplist/core/access";
import {
  type BufferedTopicEvent,
  type ConversationAudience,
  type RealtimeEvent,
  type RealtimePublisher,
  RUN_CHUNK_EVENT_TYPE,
} from "@symplist/core/events";
import { uuidv7 } from "@symplist/db";
import type { z } from "zod";
import {
  errorCode,
  type OperationalLog,
  type RuntimeTimers,
} from "../../infra/scheduler/runtime.ts";
import { RingBuffer } from "./ring-buffer.ts";
import type { TopicRegistry } from "./topic-registry.ts";
import type { UpgradeSession } from "./upgrade-gate.ts";

/** How the gateway decides guard levels: the core access service's `satisfies` (§5.4). */
export type AccessLevelPolicy = Pick<AccessService, "satisfies">;

/** The transport side of one socket; the gateway adapts a `ws` WebSocket to it. */
export interface RealtimeConnection {
  send(text: string): void;
  close(code: number, reason: string): void;
  isOpen(): boolean;
}

interface Subscription {
  readonly topic: Topic;
  readonly key: string;
  /** Frames published while the snapshot is being built; null once the subscription is live. */
  pending: string[] | null;
  overflowed: boolean;
}

/** One connected socket and what it may receive. */
export interface RealtimeSocketState {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly connectedAt: number;
  readonly access: AccessState;
  readonly admitted: boolean;
  readonly subscriptionCount: number;
}

class SocketRecord implements RealtimeSocketState {
  readonly id = uuidv7();
  readonly subscriptions = new Map<string, Subscription>();
  openTasks: readonly string[] = [];
  closed = false;
  /** The access read ticket of the state last applied; 0 for the state the upgrade resolved. */
  accessReadTicket = 0;

  constructor(
    readonly connection: RealtimeConnection,
    readonly userId: string,
    readonly sessionId: string,
    readonly connectedAt: number,
    public access: AccessState,
    public admitted: boolean,
  ) {}

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }
}

interface TopicState {
  readonly key: string;
  readonly topic: Topic;
  seq: number;
  readonly buffer: RingBuffer<BufferedFrame> | null;
  readonly subscribers: Set<SocketRecord>;
  ownerId: string | null;
  lastActivityAt: number;
}

interface BufferedFrame extends BufferedTopicEvent {
  readonly frame: string;
}

/** A producer published an event the protocol does not allow; nothing was delivered. */
export class RealtimePublishError extends Error {
  readonly code: "realtime.event_invalid" | "realtime.topic_invalid";

  constructor(code: RealtimePublishError["code"], message: string) {
    super(message);
    this.name = "RealtimePublishError";
    this.code = code;
  }
}

export type SubscribeOutcome = "subscribed" | "not_found" | "limit" | "closed";

export interface TopicHubOptions {
  readonly registry: TopicRegistry;
  readonly access: AccessLevelPolicy;
  readonly timers: RuntimeTimers;
  readonly log: OperationalLog;
  /** Chunks kept per conversation topic for replay (§7). */
  readonly bufferCapacity?: number;
  /** Frames queued for one subscription while its snapshot is built; beyond this it gets `resync`. */
  readonly pendingLimit?: number;
  /** A topic with no subscribers and no events for this long is dropped with its buffer. */
  readonly idleTopicMs?: number;
  /** Event data schemas by type; defaults to the composed contracts `wsEvents`. */
  readonly events?: Readonly<Record<string, z.ZodType>>;
}

const composedEventSchemas = wsEvents as unknown as Readonly<Record<string, z.ZodType>>;

const emptyUserSnapshot = (): UserTopicSnapshot => ({
  unreadCount: 0,
  taskTreeVersion: 0,
  heads: {},
  vaultUnlocked: false,
});

/**
 * Topics, subscriptions, sequence numbers and replay buffers for the WebSocket gateway (§7), and the
 * `RealtimePublisher` producers use. Plaintext chunks exist only in these buffers, in api memory.
 *
 * Sequence numbers of a topic start at `max(now × 1000, highest seq issued + 1)` when the topic is
 * created, so a cursor from an earlier process or an evicted topic is always below the buffer and
 * gets a snapshot instead of a wrong replay.
 */
export class TopicHub implements RealtimePublisher {
  private readonly sockets = new Set<SocketRecord>();
  private readonly byUser = new Map<string, Set<SocketRecord>>();
  private readonly bySession = new Map<string, Set<SocketRecord>>();
  private readonly topics = new Map<string, TopicState>();
  private highestSeq = 0;
  private accessReads = 0;
  private readonly endedSessions = new Map<string, { readonly at: number }>();
  private readonly endedUsers = new Map<string, { readonly at: number }>();
  private readonly accessChanges = new Map<string, { readonly at: number }>();
  private shuttingDown = false;
  private readonly bufferCapacity: number;
  private readonly pendingLimit: number;
  private readonly idleTopicMs: number;
  private readonly eventSchemas: Readonly<Record<string, z.ZodType>>;

  constructor(private readonly options: TopicHubOptions) {
    this.eventSchemas = options.events ?? composedEventSchemas;
    this.bufferCapacity = options.bufferCapacity ?? 2_000;
    this.pendingLimit = options.pendingLimit ?? 2_000;
    this.idleTopicMs = options.idleTopicMs ?? 5 * 60_000;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Stops accepting sockets, subscriptions and publications (SIGTERM, §5.5). */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /* ---------------------------------------------------------------------------------------------
   * Sockets
   * ------------------------------------------------------------------------------------------- */

  /**
   * Refuses a socket whose session ended, or whose user's access changed, after its upgrade was
   * verified: the post-commit hook can run between `verifyClient` and the connection, and the socket
   * would otherwise live on stale state until the next sweep. When every session of the user ended
   * (sign out everywhere), only sessions created at or before that moment are refused: a session the
   * user signed in with afterwards connects. Returns the close code, or null.
   */
  staleUpgrade(identity: UpgradeSession, verifiedAt: number): number | null {
    const now = this.options.timers.now();
    this.purgeRecentChanges(now);
    const ended = this.endedSessions.get(identity.sessionId);
    const userEnded = this.endedUsers.get(identity.userId);
    if (
      (ended && ended.at >= verifiedAt) ||
      (userEnded && userEnded.at >= verifiedAt && identity.sessionCreatedAt <= userEnded.at)
    ) {
      return wsCloseCodes.sessionEnded;
    }
    const changed = this.accessChanges.get(identity.userId);
    return changed && changed.at >= verifiedAt ? wsCloseCodes.accessLost : null;
  }

  /**
   * Remembers ended sessions for a minute, for `staleUpgrade`. `"all"` ends every session of the user
   * that exists now, for callers that revoke them without listing their ids.
   */
  noteSessionsEnded(userId: string, sessionIds: readonly string[] | "all"): void {
    const now = this.options.timers.now();
    this.purgeRecentChanges(now);
    if (sessionIds === "all") this.endedUsers.set(userId, { at: now });
    else for (const sessionId of sessionIds) this.endedSessions.set(sessionId, { at: now });
  }

  /** Remembers a user's access change for a minute, for `staleUpgrade`. */
  noteAccessChanged(userId: string): void {
    const now = this.options.timers.now();
    this.purgeRecentChanges(now);
    this.accessChanges.set(userId, { at: now });
  }

  connect(connection: RealtimeConnection, identity: SessionContext): RealtimeSocketState {
    const record = new SocketRecord(
      connection,
      identity.userId,
      identity.sessionId,
      this.options.timers.now(),
      identity.access,
      this.options.access.satisfies(identity.access, "admitted"),
    );
    this.sockets.add(record);
    addTo(this.byUser, record.userId, record);
    addTo(this.bySession, record.sessionId, record);
    return record;
  }

  /** Removes a socket and its subscriptions. Idempotent. */
  disconnect(socket: RealtimeSocketState): void {
    const record = socket as SocketRecord;
    if (!this.sockets.delete(record)) return;
    record.closed = true;
    for (const subscription of record.subscriptions.values()) {
      this.topics.get(subscription.key)?.subscribers.delete(record);
    }
    record.subscriptions.clear();
    removeFrom(this.byUser, record.userId, record);
    removeFrom(this.bySession, record.sessionId, record);
  }

  /** Removes the socket and closes its connection with `code`. */
  close(socket: RealtimeSocketState, code: number, reason: string): void {
    const record = socket as SocketRecord;
    this.disconnect(record);
    try {
      record.connection.close(code, reason);
    } catch {
      // The connection is already gone.
    }
  }

  connected(): readonly RealtimeSocketState[] {
    return [...this.sockets];
  }

  socketsOfUser(userId: string): readonly RealtimeSocketState[] {
    return [...(this.byUser.get(userId) ?? [])];
  }

  socketsOfSession(sessionId: string): readonly RealtimeSocketState[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  isConnected(socket: RealtimeSocketState): boolean {
    return this.sockets.has(socket as SocketRecord);
  }

  /**
   * A ticket for an access read that is about to start. Tickets increase with every call; a caller
   * takes one before reading D1 and passes it to {@link applyAccess} with the result, so results that
   * arrive out of order (a slow sweep finishing after a restriction's refresh) are recognised.
   */
  beginAccessRead(): number {
    this.accessReads += 1;
    return this.accessReads;
  }

  /**
   * Applies an access state read under `readTicket` (§5.5). Updates are monotonic, whether or not the
   * socket is admitted: a result with an older `access_generation` than the socket's state is out of
   * date and ignored, and so is one with the same generation read before the result this socket last
   * applied (fields such as `onboarding_step` change without a new generation). A newer generation is
   * always newer data. Returns false when the socket must close: it was admitted and no longer is or
   * its access generation moved, or it no longer passes the identity level.
   */
  applyAccess(socket: RealtimeSocketState, access: AccessState, readTicket: number): boolean {
    const record = socket as SocketRecord;
    const current = record.access.accessGeneration;
    if (access.accessGeneration < current) return true;
    if (access.accessGeneration === current && readTicket < record.accessReadTicket) return true;
    const identity = this.options.access.satisfies(access, "identity");
    const admitted = identity && this.options.access.satisfies(access, "admitted");
    if (!identity || (record.admitted && !admitted)) return false;
    // Every restriction and restore moves `access_generation` (§5.4). An admitted socket whose generation
    // moved lost access at some point since it was authorized, even if a restore already followed and
    // the post-commit hook ran elsewhere (another instance during a deploy) or failed: its
    // subscriptions were authorized before the restriction, so it closes and resubscribes (§5.5).
    if (record.admitted && access.accessGeneration > current) return false;
    record.access = access;
    record.admitted = admitted;
    record.accessReadTicket = Math.max(record.accessReadTicket, readTicket);
    return true;
  }

  /* ---------------------------------------------------------------------------------------------
   * Subscriptions
   * ------------------------------------------------------------------------------------------- */

  /** `{"t":"sub","topic":"user",…}`: always answered with a snapshot, never a replay (§7). */
  async subscribeUser(
    socket: RealtimeSocketState,
    openTasks: readonly string[],
  ): Promise<SubscribeOutcome> {
    const record = socket as SocketRecord;
    if (!this.live(record)) return "closed";
    const key = userKey(record.userId);
    if (!record.subscriptions.has(key) && record.subscriptions.size >= wsMaxSubscriptions) {
      return "limit";
    }
    record.openTasks = [...openTasks];
    const state = this.topicState(key, userTopic, false);
    const subscription = this.attach(record, state);
    const seq = state.seq;
    const snapshot = await this.userSnapshot(record, openTasks);
    if (!this.stillSubscribed(record, subscription)) return "closed";
    this.sendNow(record, JSON.stringify({ t: "snapshot", topic: userTopic, seq, data: snapshot }));
    this.goLive(record, subscription);
    return "subscribed";
  }

  /**
   * `{"t":"sub","topic":"conversation:<id>","cursor"}` (§7): requires admitted access and the
   * conversation authorizer; unknown and foreign conversations both return `not_found`. A cursor inside
   * the buffer replays the tail; otherwise the snapshot provider supplies persisted messages plus the
   * live partial, or the client is told to `resync` when no provider is registered.
   */
  async subscribeConversation(
    socket: RealtimeSocketState,
    topic: Topic,
    cursor: number | null,
  ): Promise<SubscribeOutcome> {
    const record = socket as SocketRecord;
    if (!this.live(record)) return "closed";
    const parsed = parseTopic(topic);
    if (parsed?.kind !== "conversation" || !record.admitted) return "not_found";
    const key = topic;
    const existing = record.subscriptions.get(key);
    if (!existing && record.subscriptions.size >= wsMaxSubscriptions) return "limit";

    const authorizer = this.options.registry.authorizer("conversation");
    if (!authorizer) return "not_found";
    let allowed: boolean;
    try {
      allowed = await authorizer.authorize(this.identity(record), parsed);
    } catch (error) {
      this.options.log.warn("realtime.authorize_failed", {
        socketId: record.id,
        kind: "conversation",
        code: errorCode(error),
      });
      allowed = false;
    }
    if (!this.live(record)) return "closed";
    if (!allowed || !record.admitted) return "not_found";
    if (!record.subscriptions.has(key) && record.subscriptions.size >= wsMaxSubscriptions) {
      return "limit";
    }

    const state = this.topicState(key, topic, true);
    if (state.ownerId !== null && state.ownerId !== record.userId) {
      this.options.log.error("realtime.owner_mismatch", { socketId: record.id, topic });
      return "not_found";
    }
    state.ownerId = record.userId;
    const subscription = this.attach(record, state);
    const buffer = state.buffer as RingBuffer<BufferedFrame>;

    if (cursor !== null && buffer.canReplayAfter(cursor, state.seq)) {
      for (const entry of buffer.after(cursor)) this.sendNow(record, entry.frame);
      this.goLive(record, subscription);
      return "subscribed";
    }

    const seq = state.seq;
    const live = buffer.upTo(seq).map(({ frame: _frame, ...event }) => event);
    const provider = this.options.registry.snapshotProvider("conversation");
    let data: unknown;
    let resync = provider === undefined;
    if (provider) {
      try {
        data = await provider.snapshot(this.identity(record), parsed, live);
      } catch (error) {
        this.options.log.warn("realtime.snapshot_failed", {
          socketId: record.id,
          kind: "conversation",
          code: errorCode(error),
        });
        resync = true;
      }
    }
    if (!this.stillSubscribed(record, subscription)) return "closed";
    this.sendNow(
      record,
      resync
        ? JSON.stringify({ t: "resync", topic })
        : JSON.stringify({ t: "snapshot", topic, seq, data: data ?? null }),
    );
    this.goLive(record, subscription);
    return "subscribed";
  }

  unsubscribe(socket: RealtimeSocketState, topic: Topic): void {
    const record = socket as SocketRecord;
    const key = topic === userTopic ? userKey(record.userId) : topic;
    const subscription = record.subscriptions.get(key);
    if (!subscription) return;
    record.subscriptions.delete(key);
    const state = this.topics.get(key);
    state?.subscribers.delete(record);
    if (state) state.lastActivityAt = this.options.timers.now();
  }

  /* ---------------------------------------------------------------------------------------------
   * Publication
   * ------------------------------------------------------------------------------------------- */

  async publish(topic: Topic, event: RealtimeEvent): Promise<void> {
    const parsed = parseTopic(topic);
    if (!parsed) throw new RealtimePublishError("realtime.topic_invalid", "Unknown topic");
    if (parsed.kind === "user") {
      throw new RealtimePublishError(
        "realtime.topic_invalid",
        "The user topic is per user: use publishToUser",
      );
    }
    this.publishConversationEvent(topic, null, event);
  }

  async publishToUser(userId: string, event: RealtimeEvent): Promise<void> {
    const { type, data } = this.checkEvent("user", event);
    if (this.shuttingDown) return;
    const state = this.topics.get(userKey(userId));
    if (!state || state.subscribers.size === 0) return;
    state.seq = this.nextSeq(state.seq);
    state.lastActivityAt = this.options.timers.now();
    const frame = this.frame(userTopic, state.seq, type, data).frame;
    const unadmittedAllowed = (unadmittedUserTopicEventTypes as readonly string[]).includes(type);
    for (const record of state.subscribers) {
      if (record.userId !== userId) continue;
      if (!record.admitted && !unadmittedAllowed) continue;
      this.deliver(record, state.key, frame);
    }
  }

  async publishToConversation(audience: ConversationAudience, event: RealtimeEvent): Promise<void> {
    this.publishConversationEvent(
      `conversation:${audience.conversationId}`,
      audience.ownerId,
      event,
    );
  }

  /** Drops idle topics without subscribers, releasing their buffered plaintext. */
  evictIdleTopics(): number {
    const now = this.options.timers.now();
    let evicted = 0;
    for (const [key, state] of this.topics) {
      if (state.subscribers.size === 0 && now - state.lastActivityAt >= this.idleTopicMs) {
        state.buffer?.clear();
        this.topics.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  /** Sequence number of a topic, for tests and diagnostics; undefined when the topic has no state. */
  topicSeq(topic: Topic, userId?: string): number | undefined {
    return this.topics.get(topic === userTopic ? userKey(userId ?? "") : topic)?.seq;
  }

  topicCount(): number {
    return this.topics.size;
  }

  /* ---------------------------------------------------------------------------------------------
   * Internals
   * ------------------------------------------------------------------------------------------- */

  private publishConversationEvent(
    topic: string,
    ownerId: string | null,
    event: RealtimeEvent,
  ): void {
    const parsed = parseTopic(topic);
    if (parsed?.kind !== "conversation") {
      throw new RealtimePublishError("realtime.topic_invalid", "Unknown conversation topic");
    }
    const { type, data } = this.checkEvent("conversation", event);
    if (this.shuttingDown) return;
    const state = this.topicState(topic, topic as Topic, true);
    if (ownerId !== null) {
      if (state.ownerId !== null && state.ownerId !== ownerId) {
        this.options.log.error("realtime.owner_mismatch", { topic });
        return;
      }
      state.ownerId = ownerId;
    }
    state.seq = this.nextSeq(state.seq);
    state.lastActivityAt = this.options.timers.now();
    const buffered = this.frame(topic as Topic, state.seq, type, data);
    state.buffer?.push(buffered);
    for (const record of state.subscribers) {
      if (!record.admitted) continue;
      if (state.ownerId !== null && record.userId !== state.ownerId) continue;
      this.deliver(record, state.key, buffered.frame);
    }
  }

  private checkEvent(
    kind: "user" | "conversation",
    event: RealtimeEvent,
  ): { readonly type: string; readonly data: unknown } {
    if (typeof event !== "object" || event === null || typeof event.type !== "string") {
      throw new RealtimePublishError("realtime.event_invalid", "Events need a type");
    }
    const { type } = event;
    if (!isStableCode(type)) {
      throw new RealtimePublishError("realtime.event_invalid", "Event types are stable codes");
    }
    if (isUserTopicEventType(type) !== (kind === "user")) {
      throw new RealtimePublishError(
        "realtime.topic_invalid",
        `${type} is not a ${kind} topic event`,
      );
    }
    const schema = Object.hasOwn(this.eventSchemas, type) ? this.eventSchemas[type] : undefined;
    if (schema) {
      const result = schema.safeParse(event.data);
      if (!result.success) {
        throw new RealtimePublishError("realtime.event_invalid", `Invalid data for ${type}`);
      }
      return { type, data: result.data };
    }
    if (kind === "conversation" && type === RUN_CHUNK_EVENT_TYPE) return { type, data: event.data };
    throw new RealtimePublishError("realtime.event_invalid", `${type} is not a declared event`);
  }

  private frame(topic: Topic, seq: number, type: string, data: unknown): BufferedFrame {
    const id = uuidv7(this.options.timers.now());
    let frame: string;
    try {
      frame = JSON.stringify({ t: "ev", topic, seq, id, type, data });
    } catch {
      throw new RealtimePublishError("realtime.event_invalid", "Event data is not serializable");
    }
    return { seq, id, type, data, frame };
  }

  /** Per-topic sequence numbers are contiguous; `highestSeq` only seeds the base of new topics. */
  private nextSeq(current: number): number {
    const next = current + 1;
    if (next > this.highestSeq) this.highestSeq = next;
    return next;
  }

  private topicState(key: string, topic: Topic, buffered: boolean): TopicState {
    let state = this.topics.get(key);
    if (!state) {
      const base = Math.max(this.options.timers.now() * 1000, this.highestSeq + 1);
      this.highestSeq = base;
      state = {
        key,
        topic,
        seq: base,
        buffer: buffered ? new RingBuffer<BufferedFrame>(this.bufferCapacity) : null,
        subscribers: new Set(),
        ownerId: null,
        lastActivityAt: this.options.timers.now(),
      };
      this.topics.set(key, state);
    }
    return state;
  }

  private attach(record: SocketRecord, state: TopicState): Subscription {
    const subscription: Subscription = {
      topic: state.topic,
      key: state.key,
      pending: [],
      overflowed: false,
    };
    record.subscriptions.set(state.key, subscription);
    state.subscribers.add(record);
    state.lastActivityAt = this.options.timers.now();
    return subscription;
  }

  private goLive(record: SocketRecord, subscription: Subscription): void {
    const pending = subscription.pending ?? [];
    subscription.pending = null;
    if (subscription.overflowed) {
      subscription.overflowed = false;
      this.sendNow(record, JSON.stringify({ t: "resync", topic: subscription.topic }));
      return;
    }
    for (const frame of pending) this.sendNow(record, frame);
  }

  private deliver(record: SocketRecord, key: string, frame: string): void {
    const subscription = record.subscriptions.get(key);
    if (!subscription) return;
    if (subscription.pending) {
      if (subscription.pending.length >= this.pendingLimit) {
        subscription.overflowed = true;
        subscription.pending = [];
      }
      if (!subscription.overflowed) subscription.pending.push(frame);
      return;
    }
    this.sendNow(record, frame);
  }

  private sendNow(record: SocketRecord, text: string): void {
    if (record.closed || !record.connection.isOpen()) return;
    try {
      record.connection.send(text);
    } catch {
      this.close(record, wsCloseCodes.goingAway, "send failed");
    }
  }

  private async userSnapshot(
    record: SocketRecord,
    openTasks: readonly string[],
  ): Promise<UserTopicSnapshot> {
    const base = emptyUserSnapshot();
    if (!record.admitted) return base;
    const merged: UserTopicSnapshot = { ...base };
    const identity = this.identity(record);
    for (const contributor of this.options.registry.userSnapshotContributors()) {
      try {
        const part = await contributor.contribute(identity, { openTasks });
        if (part.unreadCount !== undefined) merged.unreadCount = part.unreadCount;
        if (part.taskTreeVersion !== undefined) merged.taskTreeVersion = part.taskTreeVersion;
        if (part.vaultUnlocked !== undefined) merged.vaultUnlocked = part.vaultUnlocked;
        if (part.heads !== undefined) {
          const heads: Record<string, string> = { ...merged.heads };
          for (const taskId of openTasks) {
            const revision = part.heads[taskId as keyof typeof part.heads];
            if (typeof revision === "string") heads[taskId] = revision;
          }
          merged.heads = heads as UserTopicSnapshot["heads"];
        }
      } catch (error) {
        this.options.log.warn("realtime.user_snapshot_contributor_failed", {
          socketId: record.id,
          contributor: contributor.name,
          code: errorCode(error),
        });
      }
    }
    const parsed = userTopicSnapshotSchema.safeParse(merged);
    if (parsed.success) return parsed.data;
    this.options.log.error("realtime.user_snapshot_invalid", { socketId: record.id });
    return base;
  }

  private purgeRecentChanges(now: number): void {
    for (const map of [this.endedSessions, this.endedUsers, this.accessChanges]) {
      for (const [key, entry] of map) if (now - entry.at > 60_000) map.delete(key);
    }
  }

  private identity(record: SocketRecord): SessionContext {
    return { userId: record.userId, sessionId: record.sessionId, access: record.access };
  }

  private live(record: SocketRecord): boolean {
    return !this.shuttingDown && !record.closed && this.sockets.has(record);
  }

  private stillSubscribed(record: SocketRecord, subscription: Subscription): boolean {
    return this.live(record) && record.subscriptions.get(subscription.key) === subscription;
  }
}

const userKey = (userId: string) => `user:${userId}`;

function addTo(map: Map<string, Set<SocketRecord>>, key: string, record: SocketRecord): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(record);
}

function removeFrom(map: Map<string, Set<SocketRecord>>, key: string, record: SocketRecord): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(record);
  if (set.size === 0) map.delete(key);
}
