import { idSchema } from "../common/ids.ts";
import { defineEvents } from "../common/ws.ts";
import { z } from "../common/zod.ts";

export const shareGrantChangedEventSchema = z.strictObject({
  taskId: idSchema,
  artifactId: idSchema,
});

/** WebSocket events owned by the sharing feature (§13, §7), keyed by event type. */
export const sharingEvents = defineEvents({
  "share_grant.changed": shareGrantChangedEventSchema,
});
