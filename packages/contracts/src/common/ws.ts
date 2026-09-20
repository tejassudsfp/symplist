import type { FeatureId } from "../features.ts";
import { errorCodeSchema } from "./envelope.ts";
import {
  type ConversationId,
  conversationIdSchema,
  eventIdSchema,
  idSchema,
  taskIdSchema,
} from "./ids.ts";
import { counterSchema, stableCodeSchema } from "./primitives.ts";
import { z } from "./zod.ts";

/* ------------------------------------------------------------------------------------------------
 * Protocol limits (§7)
 * --------------------------------------------------------------------------------------------- */

/** The single WebSocket endpoint on the api host. The global `/v1` prefix does not apply to it. */
export const wsPath = "/v1/ws";

/** `maxPayload` of the gateway: larger client frames close the socket. */
export const wsMaxPayloadBytes = 16_384;

/** At most this many open task ids in a `user` subscription. */
export const wsMaxOpenTasks = 20;

/** More subscriptions than this on one socket close it with 1008. */
export const wsMaxSubscriptions = 50;

/** More client frames than this per window close the socket with 1008. */
export const wsClientFrameRateLimit = Object.freeze({ frames: 20, windowMs: 10_000 } as const);

/** The server pings every 30 seconds and closes idle sockets. */
export const wsHeartbeatIntervalMs = 30_000;

/** Close codes used by the gateway (§5.5, §7). */
export const wsCloseCodes = Object.freeze({
  /** Server shutdown or deploy; the client reconnects with jittered backoff. */
  goingAway: 1001,
  /** Frame rate, subscription count or payload limit exceeded. */
  policyViolation: 1008,
  /** Logout, session revocation or session expiry. */
  sessionEnded: 4401,
  /** Access was lost (relock, suspension, deletion). */
  accessLost: 4403,
} as const);

export type WsCloseCode = (typeof wsCloseCodes)[keyof typeof wsCloseCodes];

/* ------------------------------------------------------------------------------------------------
 * Topics
 * --------------------------------------------------------------------------------------------- */

/** The per-user topic. */
export const userTopic = "user";
export type UserTopic = typeof userTopic;

/** One topic per conversation, named by its UUIDv7. */
export type ConversationTopic = `conversation:${string}`;

/** WebSocket topics (§7): the per-user topic and one topic per conversation. */
export type Topic = UserTopic | ConversationTopic;

const conversationTopicPrefix = "conversation:";

export const conversationTopicSchema = z.templateLiteral([conversationTopicPrefix, idSchema], {
  error: "Expected conversation:<UUIDv7>",
});

export const topicSchema = z.union([z.literal(userTopic), conversationTopicSchema], {
  error: "Expected the user topic or conversation:<UUIDv7>",
});

/** The topic name for a conversation. */
export function conversationTopic(conversationId: ConversationId): ConversationTopic {
  return `${conversationTopicPrefix}${conversationId}`;
}

export type ParsedTopic =
  | { readonly kind: "user" }
  | { readonly kind: "conversation"; readonly conversationId: ConversationId };

/** Parses a topic name, or returns null when it is not a valid topic. */
export function parseTopic(topic: string): ParsedTopic | null {
  if (topic === userTopic) return { kind: "user" };
  if (!conversationTopicSchema.safeParse(topic).success) return null;
  const conversationId = conversationIdSchema.parse(topic.slice(conversationTopicPrefix.length));
  return { kind: "conversation", conversationId };
}

/** Per-topic sequence numbers; clients resubscribe with the last one they applied. */
export const seqSchema = counterSchema;

/* ------------------------------------------------------------------------------------------------
 * Client frames: sub, unsub, ping. Commands go through HTTP with idempotency, never the socket.
 * --------------------------------------------------------------------------------------------- */

/** `{"t":"sub","topic":"user","cursor":null,"openTasks":[…]}`: the user topic always snapshots. */
export const subscribeUserFrameSchema = z.strictObject({
  t: z.literal("sub"),
  topic: z.literal(userTopic),
  cursor: z.null(),
  openTasks: z
    .array(taskIdSchema)
    .max(wsMaxOpenTasks, { error: `At most ${wsMaxOpenTasks} open tasks` })
    .refine((ids) => new Set(ids).size === ids.length, { error: "Open tasks must be unique" }),
});

/** `{"t":"sub","topic":"conversation:<id>","cursor":<seq|null>}`. */
export const subscribeConversationFrameSchema = z.strictObject({
  t: z.literal("sub"),
  topic: conversationTopicSchema,
  cursor: seqSchema.nullable(),
});

/** `{"t":"unsub","topic"}`. */
export const unsubscribeFrameSchema = z.strictObject({
  t: z.literal("unsub"),
  topic: topicSchema,
});

/** `{"t":"ping"}`. */
export const pingFrameSchema = z.strictObject({ t: z.literal("ping") });

/** Every frame a client may send on `/v1/ws` (§7). */
export const clientFrameSchema = z.union([
  subscribeUserFrameSchema,
  subscribeConversationFrameSchema,
  unsubscribeFrameSchema,
  pingFrameSchema,
]);

/** Frames a client may send on `/v1/ws` (§7). */
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export type ClientFrameDecodeResult =
  | { readonly ok: true; readonly frame: ClientFrame }
  | { readonly ok: false; readonly code: "validation" };

/**
 * Decodes one text frame from a client. Oversized, malformed and unknown frames all return
 * `validation`, which the gateway sends back as `{"t":"err","code":"validation"}`.
 */
export function decodeClientFrame(text: string): ClientFrameDecodeResult {
  // A UTF-16 string never encodes to fewer UTF-8 bytes than it has code units.
  if (text.length > wsMaxPayloadBytes) return { ok: false, code: "validation" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "validation" };
  }
  const result = clientFrameSchema.safeParse(value);
  return result.success ? { ok: true, frame: result.data } : { ok: false, code: "validation" };
}

/* ------------------------------------------------------------------------------------------------
 * Server frames: ev, snapshot, resync, err, pong
 * --------------------------------------------------------------------------------------------- */

/** Event types are stable dotted identifiers such as `tasks.changed` or `chunk`. */
export const eventTypeSchema = stableCodeSchema;

/** The base event envelope `{"t":"ev","topic","seq","id","type","data"}` before `data` is typed. */
export const eventEnvelopeSchema = z.strictObject({
  t: z.literal("ev"),
  topic: topicSchema,
  seq: seqSchema,
  id: eventIdSchema,
  type: eventTypeSchema,
  data: z.unknown(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** `{"t":"snapshot","topic","seq","data"}`, sent instead of a replay when the cursor is too old. */
export const snapshotFrameSchema = z.strictObject({
  t: z.literal("snapshot"),
  topic: topicSchema,
  seq: seqSchema,
  data: z.unknown(),
});

/** `{"t":"resync","topic"}`: the client must reload the topic's state. */
export const resyncFrameSchema = z.strictObject({
  t: z.literal("resync"),
  topic: topicSchema,
});

/** `{"t":"err","code"}`, for example `not_found` for an unknown or foreign conversation. */
export const errorFrameSchema = z.strictObject({
  t: z.literal("err"),
  code: errorCodeSchema,
});

/** `{"t":"pong"}`. */
export const pongFrameSchema = z.strictObject({ t: z.literal("pong") });

/**
 * The `user` topic snapshot (§7): sent on every user-topic subscription instead of a replay.
 * `heads` maps each open task to its current document revision.
 */
export const userTopicSnapshotSchema = z.strictObject({
  unreadCount: counterSchema,
  taskTreeVersion: counterSchema,
  heads: z
    .record(
      taskIdSchema,
      z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, { error: "Expected a revision" }),
    )
    .refine((heads) => Object.keys(heads).length <= wsMaxOpenTasks, {
      error: `At most ${wsMaxOpenTasks} heads`,
    }),
  vaultUnlocked: z.boolean(),
});

export type UserTopicSnapshot = z.infer<typeof userTopicSnapshotSchema>;

/* ------------------------------------------------------------------------------------------------
 * Events
 * --------------------------------------------------------------------------------------------- */

/**
 * The `user` topic events of §7, each owned by one feature. They are placeholders: the owning
 * feature declares the event and its data schema in `contracts/src/<feature>/events.ts`, and the
 * composition test fails if any other feature declares one of these names. Every event type that is
 * not listed here is a `conversation:<id>` event (owned by Simon).
 */
export const userTopicEventOwners = Object.freeze({
  "tasks.changed": "workspace",
  "notifications.created": "scheduling",
  "notifications.read": "scheduling",
  "notifications.summary": "scheduling",
  "access.changed": "access",
  "preferences.changed": "workspace",
  "run.status": "simon",
  "document.head_changed": "documents",
  "schedule.changed": "scheduling",
  "vault.locked": "vault",
  "connection.status_changed": "connections",
  "share_grant.changed": "sharing",
  "search.freshness": "search",
} as const satisfies Readonly<Record<string, FeatureId>>);

export type UserTopicEventType = keyof typeof userTopicEventOwners;

/** The user-topic event types owned by one feature. */
export type UserTopicEventTypeOf<Feature extends FeatureId> = {
  [Type in UserTopicEventType]: (typeof userTopicEventOwners)[Type] extends Feature ? Type : never;
}[UserTopicEventType];

export const userTopicEventTypes = Object.freeze(
  Object.keys(userTopicEventOwners),
) as readonly UserTopicEventType[];

export function isUserTopicEventType(type: string): type is UserTopicEventType {
  return Object.hasOwn(userTopicEventOwners, type);
}

/**
 * The user-topic events declared by a feature other than their owner, as readable messages. The
 * composed contracts index must return an empty list.
 */
export function misownedUserTopicEvents(
  eventsByFeature: Readonly<Partial<Record<FeatureId, EventSchemaMap>>>,
): string[] {
  const problems: string[] = [];
  for (const [feature, events] of Object.entries(eventsByFeature)) {
    for (const type of Object.keys(events ?? {})) {
      if (isUserTopicEventType(type) && userTopicEventOwners[type] !== feature) {
        problems.push(
          `${type} is owned by ${userTopicEventOwners[type]} but declared by ${feature}`,
        );
      }
    }
  }
  return problems;
}

/** For users who are not admitted, the user topic carries only these access-state events (§7). */
export const unadmittedUserTopicEventTypes = Object.freeze([
  "access.changed",
] as const satisfies readonly UserTopicEventType[]);

/** A feature's WebSocket event data schemas, keyed by event type (for example `tasks.changed`). */
export type EventSchemaMap = Readonly<Record<string, z.ZodType>>;

/**
 * Declares a feature's WebSocket events with their literal types preserved. Throws when an event
 * type is not a stable dotted identifier.
 */
export function defineEvents<const Events extends EventSchemaMap>(
  events: Events,
): Readonly<Events> {
  for (const type of Object.keys(events)) {
    if (!eventTypeSchema.safeParse(type).success) {
      throw new Error(`Invalid WebSocket event type "${type}": use lowercase dotted identifiers`);
    }
  }
  return Object.freeze(events);
}

/** The discriminated union of `{ type, data }` pairs described by an event schema map. */
export type EventUnion<Events extends EventSchemaMap> = {
  [Type in keyof Events & string]: { type: Type; data: z.infer<Events[Type]> };
}[keyof Events & string];

/** Frames the server sends (§7). `Event` is the union of events the topic can carry. */
export type ServerFrame<
  Event extends { type: string; data: unknown } = { type: string; data: unknown },
> =
  | ({ t: "ev"; topic: Topic; seq: number; id: string } & Event)
  | { t: "snapshot"; topic: Topic; seq: number; data: unknown }
  | { t: "resync"; topic: Topic }
  | { t: "err"; code: string }
  | { t: "pong" };

/**
 * The schema of every server frame for an event map. Each `ev` frame is checked against its event's
 * data schema and topic: user-topic events travel only on `user`, every other event only on a
 * conversation topic. Unknown event types are rejected.
 */
export function serverFrameSchemaFor<const Events extends EventSchemaMap>(
  events: Events,
): z.ZodType<ServerFrame<EventUnion<Events>>> {
  const eventFrames = Object.entries(events).map(([type, data]) =>
    z.strictObject({
      t: z.literal("ev"),
      topic: isUserTopicEventType(type) ? z.literal(userTopic) : conversationTopicSchema,
      seq: seqSchema,
      id: eventIdSchema,
      type: z.literal(type),
      data,
    }),
  );
  const schema = z.union([
    ...eventFrames,
    snapshotFrameSchema,
    resyncFrameSchema,
    errorFrameSchema,
    pongFrameSchema,
  ]);
  // The union's inferred output is structurally the frame union; the event variants are built from
  // the map at runtime, so the precise type is restored here once.
  return schema as unknown as z.ZodType<ServerFrame<EventUnion<Events>>>;
}
