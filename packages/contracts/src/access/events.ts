import { accessStateSchema } from "../common/access.ts";
import { defineEvents } from "../common/ws.ts";
import { z } from "../common/zod.ts";

/** Data of `access.changed`: the account's access fields after the change (§5.4, §7). */
export const accessChangedEventSchema = z.strictObject({ accessState: accessStateSchema });
export type AccessChangedEvent = z.infer<typeof accessChangedEventSchema>;

/**
 * WebSocket events owned by the access feature (§5, §7), keyed by event type. `access.changed` is the
 * only event a socket that is not admitted receives; it forces the client to the correct gate.
 */
export const accessEvents = defineEvents({
  "access.changed": accessChangedEventSchema,
});
