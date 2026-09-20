import { idSchema } from "../common/ids.ts";
import { defineEvents } from "../common/ws.ts";
import { z } from "../common/zod.ts";

/** WebSocket events owned by the connections feature (§14, §7), keyed by event type. */
export const connectionsEvents = defineEvents({
  "connection.status_changed": z.strictObject({ connectionId: idSchema }),
});
