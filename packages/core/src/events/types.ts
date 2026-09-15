import type { Topic, WsEvent } from "@symplist/contracts";

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

/** Publishes WebSocket events to authorized subscribers of a topic (§7). */
export interface RealtimePublisher {
  publish(topic: Topic, event: WsEvent): Promise<void>;
}
