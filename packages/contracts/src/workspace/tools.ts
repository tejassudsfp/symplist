import { z } from "zod";
import { taskIdSchema } from "../common/ids.ts";
import { defineTools } from "../common/tools.ts";
import { taskCollectionSchema, taskTitleInputSchema } from "./dto.ts";

/**
 * `task_create` (§8.7, §14.6): Simon and connected agents create a task from a title. A connected
 * agent's top-level task lands in Unclassified (its `collection` is ignored); a subtask inherits its
 * parent's collection.
 */
export const taskCreateToolInputSchema = z.strictObject({
  title: taskTitleInputSchema,
  collection: taskCollectionSchema.optional(),
  parentTaskId: taskIdSchema.optional(),
});
export type TaskCreateToolInput = z.infer<typeof taskCreateToolInputSchema>;

export const taskCreateToolOutputSchema = z.strictObject({
  taskId: taskIdSchema,
  collection: taskCollectionSchema,
  parentTaskId: taskIdSchema.nullable(),
  /** False when a retry of the same call found the task it already created. */
  created: z.boolean(),
});
export type TaskCreateToolOutput = z.infer<typeof taskCreateToolOutputSchema>;

/**
 * `task_move` (§8.7, §14.6): moves a task and its subtasks to a collection. A subtask becomes top
 * level there (decision P3).
 */
export const taskMoveToolInputSchema = z.strictObject({
  taskId: taskIdSchema,
  collection: taskCollectionSchema,
});
export type TaskMoveToolInput = z.infer<typeof taskMoveToolInputSchema>;

export const taskMoveToolOutputSchema = z.strictObject({
  taskId: taskIdSchema,
  collection: taskCollectionSchema,
  parentTaskId: taskIdSchema.nullable(),
  movedTaskIds: z.array(taskIdSchema).min(1),
});
export type TaskMoveToolOutput = z.infer<typeof taskMoveToolOutputSchema>;

/** Simon and MCP tool contracts owned by the workspace feature (§2.1 and §10.3, §8.7, §14.6). */
export const workspaceTools = defineTools({
  task_create: { input: taskCreateToolInputSchema, output: taskCreateToolOutputSchema },
  task_move: { input: taskMoveToolInputSchema, output: taskMoveToolOutputSchema },
});
