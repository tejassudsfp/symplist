import type { ClientFrame, Topic } from "@symplist/contracts";
import { z } from "zod";

/** Server frames (§7), validated before any handler sees them. */
const topicSchema = z.union([
  z.literal("user"),
  z.string().regex(/^conversation:[A-Za-z0-9_-]{1,128}$/) as z.ZodType<`conversation:${string}`>,
]);

const seqSchema = z.number().int().nonnegative();

export const serverFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("ev"),
    topic: topicSchema,
    seq: seqSchema,
    id: z.string().min(1),
    type: z.string().min(1),
    data: z.unknown(),
  }),
  z.object({ t: z.literal("snapshot"), topic: topicSchema, seq: seqSchema, data: z.unknown() }),
  z.object({ t: z.literal("resync"), topic: topicSchema }),
  z.object({ t: z.literal("err"), code: z.string().min(1) }),
  z.object({ t: z.literal("pong") }),
]);

export type ParsedServerFrame = z.infer<typeof serverFrameSchema>;
export type EventFrame = Extract<ParsedServerFrame, { t: "ev" }>;
export type SnapshotFrame = Extract<ParsedServerFrame, { t: "snapshot" }>;

/** Parses one message; returns null for anything that is not a valid server frame. */
export function parseServerFrame(raw: unknown): ParsedServerFrame | null {
  if (typeof raw !== "string" || raw.length > 1_048_576) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = serverFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Maximum task ids in a `user` subscription (§7). */
export const MAX_OPEN_TASKS = 20;
/** The server closes sockets with more than 50 subscriptions (§7). */
export const MAX_SUBSCRIPTIONS = 50;

const conversationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function conversationTopic(conversationId: string): `conversation:${string}` {
  if (!conversationIdPattern.test(conversationId)) {
    throw new TypeError("Conversation ids contain only letters, digits, - and _");
  }
  return `conversation:${conversationId}`;
}

export function userSubscribeFrame(openTasks: readonly string[]): ClientFrame {
  if (openTasks.length > MAX_OPEN_TASKS) {
    throw new RangeError(`A user subscription names at most ${MAX_OPEN_TASKS} open tasks`);
  }
  for (const taskId of openTasks) {
    if (!conversationIdPattern.test(taskId)) throw new TypeError("Invalid task id");
  }
  return { t: "sub", topic: "user", cursor: null, openTasks: [...openTasks] };
}

export function conversationSubscribeFrame(
  topic: `conversation:${string}`,
  cursor: number | null,
): ClientFrame {
  return { t: "sub", topic, cursor };
}

export function unsubscribeFrame(topic: Topic): ClientFrame {
  return { t: "unsub", topic };
}

export const pingFrame: ClientFrame = { t: "ping" };
