import { defineEvents } from "../common/ws.ts";
import { z } from "../common/zod.ts";

/** WebSocket events owned by the scheduling feature (§12, §7), keyed by event type. */
export const schedulingEvents = defineEvents({
  "notifications.changed": z
    .object({
      notificationId: z.string().uuid().nullable(),
      unreadCount: z.number().int().nonnegative(),
    })
    .strict(),
  "notifications.summary": z.object({ count: z.number().int().nonnegative() }).strict(),
  "schedule.changed": z
    .object({ taskId: z.string().uuid(), version: z.number().int().nonnegative() })
    .strict(),
});
