import { defineTools } from "../common/tools.ts";
import { z } from "../common/zod.ts";
import {
  schedulingDeadlineSchema,
  schedulingReminderInputSchema,
  schedulingSnapshotSchema,
  schedulingSnoozeSchema,
} from "./dto.ts";

const mutation = { taskId: z.string().uuid(), expectedVersion: z.number().int().nonnegative() };
export const taskScheduleToolInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read"), taskId: z.string().uuid() }).strict(),
  z
    .object({
      ...mutation,
      operation: z.literal("set_deadline"),
      deadline: schedulingDeadlineSchema,
    })
    .strict(),
  z
    .object({
      ...mutation,
      operation: z.literal("clear_deadline"),
      removeRelativeReminders: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...mutation,
      operation: z.literal("add_reminder"),
      reminder: schedulingReminderInputSchema.omit({ id: true }),
    })
    .strict(),
  z
    .object({
      ...mutation,
      operation: z.literal("update_reminder"),
      reminderId: z.string().uuid(),
      reminder: schedulingReminderInputSchema.omit({ id: true }),
    })
    .strict(),
  z
    .object({ ...mutation, operation: z.literal("cancel_reminder"), reminderId: z.string().uuid() })
    .strict(),
  z
    .object({
      ...mutation,
      operation: z.literal("snooze"),
      reminderId: z.string().uuid(),
      when: schedulingSnoozeSchema,
    })
    .strict(),
]);
export type TaskScheduleToolInput = z.infer<typeof taskScheduleToolInputSchema>;

/** Simon and MCP tool contracts owned by the scheduling feature (§12, §8.7, §14.6). */
export const schedulingTools = defineTools({
  task_schedule: { input: taskScheduleToolInputSchema, output: schedulingSnapshotSchema },
});
