import { idSchema, taskIdSchema } from "../common/ids.ts";
import { z } from "../common/zod.ts";
import { taskScheduleToolInputSchema } from "../scheduling/tools.ts";
import { taskCollectionSchema } from "../workspace/dto.ts";
import {
  labelCreateToolInputSchema,
  labelListToolInputSchema,
  taskCreateToolInputSchema,
  taskMoveToolInputSchema,
  taskSetLabelsToolInputSchema,
} from "../workspace/tools.ts";

export const mcpTaskContextSchema = z.strictObject({ taskId: taskIdSchema });
export const mcpTaskListSchema = z.strictObject({
  collection: taskCollectionSchema.optional(),
  cursor: taskIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const mcpTaskSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  taskId: taskIdSchema.optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
/** A caller-generated UUID identifies a logical mutation across disconnected MCP requests. */
export const mcpTaskCreateSchema = taskCreateToolInputSchema.extend({ requestId: idSchema });
export const mcpTaskMoveSchema = taskMoveToolInputSchema.extend({ requestId: idSchema });
/*
 * Labels take no `requestId`. `label_create` resolves a name already in use to the label that has it,
 * and `task_set_labels` replaces the whole set, so each is already what a retry of it would be.
 */
export const mcpLabelListSchema = labelListToolInputSchema;
export const mcpLabelCreateSchema = labelCreateToolInputSchema;
export const mcpTaskSetLabelsSchema = taskSetLabelsToolInputSchema;
export const mcpTaskMessageSchema = z.strictObject({
  taskId: taskIdSchema,
  requestId: idSchema,
  text: z.string().trim().min(1).max(32000),
  tier: z.enum(["fast", "smart"]).default("fast"),
});
export const mcpTaskRunSchema = z.strictObject({ runId: idSchema });
export const mcpTaskScheduleSchema = z.union(
  taskScheduleToolInputSchema.options.map((option) =>
    option.extend({
      requestId: option.shape.operation.value === "read" ? idSchema.optional() : idSchema,
    }),
  ),
);
