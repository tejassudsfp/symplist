import { taskIdSchema } from "../common/ids.ts";
import { counterSchema } from "../common/primitives.ts";
import { defineEvents } from "../common/ws.ts";
import { z } from "../common/zod.ts";
import { preferenceGroupSchema, TASKS_CHANGED_MAX_IDS } from "./dto.ts";

/**
 * `tasks.changed` (§7): the owner's task tree moved to `taskTreeVersion`. `taskIds` names the tasks
 * whose rows changed, or is empty when more than `TASKS_CHANGED_MAX_IDS` changed; a client whose
 * loaded tree is older than the version refetches.
 */
export const tasksChangedEventSchema = z.strictObject({
  taskTreeVersion: counterSchema,
  taskIds: z.array(taskIdSchema).max(TASKS_CHANGED_MAX_IDS),
});
export type TasksChangedEvent = z.infer<typeof tasksChangedEventSchema>;

/** `preferences.changed` (§7): a group was saved at `version`, possibly from another device. */
export const preferencesChangedEventSchema = z.strictObject({
  group: preferenceGroupSchema,
  version: counterSchema,
});
export type PreferencesChangedEvent = z.infer<typeof preferencesChangedEventSchema>;

/** WebSocket events owned by the workspace feature (§2.1 and §10.3, §7), keyed by event type. */
export const workspaceEvents = defineEvents({
  "tasks.changed": tasksChangedEventSchema,
  "preferences.changed": preferencesChangedEventSchema,
});
