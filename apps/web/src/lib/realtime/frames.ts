import {
  type ClientFrame,
  type ConversationId,
  type ConversationTopic,
  conversationTopic as contractsConversationTopic,
  conversationIdSchema,
  errorFrameSchema,
  eventEnvelopeSchema,
  pingFrameSchema,
  pongFrameSchema,
  resyncFrameSchema,
  snapshotFrameSchema,
  subscribeConversationFrameSchema,
  subscribeUserFrameSchema,
  type TaskId,
  type Topic,
  taskIdSchema,
  unsubscribeFrameSchema,
  userTopic,
  wsMaxOpenTasks,
  wsMaxSubscriptions,
} from "@symplist/contracts";
import { z } from "zod";

/** Longest server message the client parses (1 MiB); longer messages are ignored unparsed. */
export const MAX_SERVER_FRAME_LENGTH = 1_048_576;

/**
 * Server frames (§7), validated before any handler sees them. Topics, sequence numbers, event ids,
 * event types and error codes come from the contracts frame schemas. Event `data` stays `unknown`
 * here: feature event decoding happens in each feature through its contracts event schema.
 */
export const serverFrameSchema = z.discriminatedUnion("t", [
  eventEnvelopeSchema,
  snapshotFrameSchema,
  resyncFrameSchema,
  errorFrameSchema,
  pongFrameSchema,
]);

export type ParsedServerFrame = z.infer<typeof serverFrameSchema>;
export type EventFrame = Extract<ParsedServerFrame, { t: "ev" }>;
export type SnapshotFrame = Extract<ParsedServerFrame, { t: "snapshot" }>;

/** Parses one message; returns null for anything that is not a valid server frame. */
export function parseServerFrame(raw: unknown): ParsedServerFrame | null {
  if (typeof raw !== "string" || raw.length > MAX_SERVER_FRAME_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = serverFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Maximum task ids in a `user` subscription (§7), from the contracts. */
export const MAX_OPEN_TASKS = wsMaxOpenTasks;
/** The server closes sockets with more than this many subscriptions (§7), from the contracts. */
export const MAX_SUBSCRIPTIONS = wsMaxSubscriptions;

/** A `user` topic subscription frame with validated, unique open task ids. */
export type UserSubscribeFrame = z.infer<typeof subscribeUserFrameSchema>;

/** Checks a conversation id against the contracts schema (a lowercase UUIDv7). */
export function parseConversationId(value: string): ConversationId {
  const parsed = conversationIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Conversation ids are lowercase UUIDv7 strings");
  return parsed.data;
}

/** The topic for a conversation; throws a TypeError when the id is not a valid conversation id. */
export function conversationTopic(conversationId: ConversationId): ConversationTopic {
  return contractsConversationTopic(parseConversationId(conversationId));
}

/**
 * The `user` subscription frame. Repeated task ids are sent once; more than `MAX_OPEN_TASKS` throws a
 * RangeError and an id that is not a valid task id throws a TypeError.
 */
export function userSubscribeFrame(openTasks: readonly TaskId[]): UserSubscribeFrame {
  const unique = [...new Set<string>(openTasks)];
  if (unique.length > wsMaxOpenTasks) {
    throw new RangeError(`A user subscription names at most ${wsMaxOpenTasks} open tasks`);
  }
  const taskIds = unique.map((taskId) => {
    const parsed = taskIdSchema.safeParse(taskId);
    if (!parsed.success) throw new TypeError("Task ids are lowercase UUIDv7 strings");
    return parsed.data;
  });
  return subscribeUserFrameSchema.parse({
    t: "sub",
    topic: userTopic,
    cursor: null,
    openTasks: taskIds,
  });
}

export function conversationSubscribeFrame(
  topic: ConversationTopic,
  cursor: number | null,
): ClientFrame {
  return subscribeConversationFrameSchema.parse({ t: "sub", topic, cursor });
}

export function unsubscribeFrame(topic: Topic): ClientFrame {
  return unsubscribeFrameSchema.parse({ t: "unsub", topic });
}

export const pingFrame: ClientFrame = pingFrameSchema.parse({ t: "ping" });
