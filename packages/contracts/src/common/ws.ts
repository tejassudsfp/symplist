import type { z } from "zod";

/** WebSocket topics (§7): the per-user topic and one topic per conversation. */
export type Topic = "user" | `conversation:${string}`;

/** Frames a client may send on `/v1/ws` (§7). Commands go through HTTP, never the socket. */
export type ClientFrame =
  | { t: "sub"; topic: "user"; cursor: null; openTasks: readonly string[] }
  | { t: "sub"; topic: `conversation:${string}`; cursor: number | null }
  | { t: "unsub"; topic: Topic }
  | { t: "ping" };

/** A feature's WebSocket event data schemas, keyed by event type (for example `tasks.changed`). */
export type EventSchemaMap = Readonly<Record<string, z.ZodType>>;

/** Declares a feature's WebSocket events with their literal types preserved. */
export function defineEvents<const Events extends EventSchemaMap>(
  events: Events,
): Readonly<Events> {
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
