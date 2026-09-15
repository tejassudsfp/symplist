import type {
  ParsedTopic,
  RestrictionReason,
  Topic,
  UserTopicSnapshot,
  WsEvent,
} from "@symplist/contracts";
import type { SessionContext } from "../access/types.ts";
import type { InternalEventPayload } from "./wire.ts";

/**
 * A change announced between runtimes. The worker signs and posts these to
 * `/internal/v1/events` (§6.2); payloads carry only ids, enums, counts, sequence numbers and
 * encrypted envelopes, and are treated as untrusted hints.
 */
export interface InternalEvent<Type extends string = string, Payload = unknown> {
  readonly id: string;
  readonly type: Type;
  readonly ownerId: string;
  /** UTC epoch milliseconds. */
  readonly occurredAt: number;
  readonly payload: Payload;
}

/** Any WebSocket event: a stable dotted type and its data. `WsEvent` narrows it to declared events. */
export interface RealtimeEvent {
  readonly type: string;
  readonly data: unknown;
}

/** The conversation a publication targets, with its owner re-read from D1 by the producer. */
export interface ConversationAudience {
  readonly ownerId: string;
  readonly conversationId: string;
}

/**
 * Publishes WebSocket events to authorized subscribers of a topic (§7). Producers publish only after
 * re-reading ownership and authorization from D1 (§6.2).
 */
export interface RealtimePublisher {
  /**
   * Publishes on a `conversation:<id>` topic to its authorized subscribers and its replay buffer. The
   * `user` topic exists once per user, so `publish("user", …)` is rejected: use `publishToUser`.
   */
  publish(topic: Topic, event: WsEvent): Promise<void>;
  /** Publishes on one user's `user` topic. Sockets that are not admitted receive access-state events only. */
  publishToUser(userId: string, event: WsEvent): Promise<void>;
  /** Publishes on a conversation topic, delivered only to sockets of `audience.ownerId`. */
  publishToConversation(audience: ConversationAudience, event: WsEvent): Promise<void>;
}

/** Topic kinds other than `user`, each authorized by the feature that owns it. */
export type AuthorizedTopicKind = Exclude<ParsedTopic["kind"], "user">;

/**
 * A feature's ownership check for one topic kind (§7), registered with the gateway. It must re-read
 * D1 and return true only when the resource exists and belongs to `socket.userId`; unknown and
 * foreign resources both return false, which the gateway answers with `not_found`.
 */
export interface TopicAuthorizer<Kind extends AuthorizedTopicKind = AuthorizedTopicKind> {
  readonly kind: Kind;
  authorize(socket: SessionContext, topic: Extract<ParsedTopic, { kind: Kind }>): Promise<boolean>;
}

/** One buffered event of a topic, as replayed to a reconnecting client (§7). */
export interface BufferedTopicEvent {
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
}

/**
 * Builds the `snapshot` data for a topic kind when a cursor is missing or outside the replay buffer:
 * for conversations, the persisted messages plus the live partial (§7). `live` is the buffer tail up
 * to the snapshot's `seq`. Called only after the topic authorizer allowed the subscription.
 */
export interface TopicSnapshotProvider<Kind extends AuthorizedTopicKind = AuthorizedTopicKind> {
  readonly kind: Kind;
  snapshot(
    socket: SessionContext,
    topic: Extract<ParsedTopic, { kind: Kind }>,
    live: readonly BufferedTopicEvent[],
  ): Promise<unknown>;
}

/**
 * Contributes fields of the `user` topic snapshot `{unreadCount, taskTreeVersion, heads,
 * vaultUnlocked}` (§7). Each feature supplies its own fields; absent fields default to zero, empty or
 * false. Contributors run only for admitted sockets.
 */
export interface UserSnapshotContributor {
  readonly name: string;
  contribute(
    socket: SessionContext,
    input: { readonly openTasks: readonly string[] },
  ): Promise<Partial<UserTopicSnapshot>>;
}

/** Why a login session's sockets are closed with 4401 (§5.1). */
export type SessionEndReason = "logout" | "revoked" | "expired" | "deleted";

export interface SessionsEndedEvent {
  readonly userId: string;
  /** The ended auth sessions, or `all` when every session of the user was revoked (§5.6). */
  readonly sessionIds: readonly string[] | "all";
  readonly reason: SessionEndReason;
}

export interface AccessRestrictedEvent {
  readonly userId: string;
  readonly reason: RestrictionReason;
  /** Runs the restriction batch cancelled or stopped; durable ones get Trigger `runs.cancel` (§5.5). */
  readonly cancelledRunIds: readonly string[];
}

/**
 * Effects that run after a logout, session revocation or restriction batch commits (§5.1, §5.5). The
 * restriction routine calls every registered hook; the realtime gateway closes sockets and the
 * executors cancel durable runs. Hooks never throw for delivery problems.
 */
export interface AccessPostCommitHook {
  onSessionsEnded(event: SessionsEndedEvent): Promise<void>;
  onAccessRestricted(event: AccessRestrictedEvent): Promise<void>;
}

/**
 * Handles one internal event type from the worker (§6.2, §7). The payload is an untrusted hint: the
 * handler re-reads ownership and state from D1 and re-authorizes before publishing anything.
 */
export interface InternalEventHandler<Type extends string = string> {
  readonly type: Type;
  handle(event: InternalEvent<Type, InternalEventPayload>): Promise<void>;
}
