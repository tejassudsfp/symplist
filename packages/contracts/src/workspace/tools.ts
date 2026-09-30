import { idSchema, taskIdSchema } from "../common/ids.ts";
import { defineTools } from "../common/tools.ts";
import { z } from "../common/zod.ts";
import { taskCollectionSchema, taskTitleInputSchema } from "./dto.ts";
import {
  LABEL_MAX_PER_TASK,
  labelColourSchema,
  labelNameSchema,
  labelViewSchema,
  taskLabelsSchema,
} from "./labels.ts";

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

/**
 * `label_list` (§2.1): the labels a connected agent may use, so it can name one before applying it.
 *
 * A grant restricted to particular tasks sees only the labels already on those tasks. A label name is
 * the person's own vocabulary, and a grant over three tasks is not a reason to learn the whole of it.
 */
export const labelListToolInputSchema = z.strictObject({});
export type LabelListToolInput = z.infer<typeof labelListToolInputSchema>;

export const labelListToolOutputSchema = z.strictObject({
  labels: z.array(labelViewSchema),
});
export type LabelListToolOutput = z.infer<typeof labelListToolOutputSchema>;

/**
 * `label_create` (§2.1): adds a word to the person's vocabulary. Requires all-task scope, because a
 * label belongs to the whole list rather than to the tasks a grant covers.
 *
 * There is no `label_rename` and no `label_delete`: either one changes every task carrying the label,
 * including tasks outside the grant, and a person's own words are not an agent's to withdraw.
 */
export const labelCreateToolInputSchema = z.strictObject({
  name: labelNameSchema,
  colour: labelColourSchema,
});
export type LabelCreateToolInput = z.infer<typeof labelCreateToolInputSchema>;

export const labelCreateToolOutputSchema = z.strictObject({
  labelId: idSchema,
  name: z.string(),
  colour: labelColourSchema,
  /** False when the name was already in use, and this is the label that has it. */
  created: z.boolean(),
});
export type LabelCreateToolOutput = z.infer<typeof labelCreateToolOutputSchema>;

/**
 * `task_set_labels` (§2.1): replaces the labels one task carries.
 *
 * The whole set rather than an add and a remove, so a retry is a no-op and two surfaces editing at
 * once settle on a state the person can see. That is also why it takes no `requestId`.
 */
export const taskSetLabelsToolInputSchema = z.strictObject({
  taskId: taskIdSchema,
  labelIds: z.array(idSchema).max(LABEL_MAX_PER_TASK),
});
export type TaskSetLabelsToolInput = z.infer<typeof taskSetLabelsToolInputSchema>;

export const taskSetLabelsToolOutputSchema = taskLabelsSchema;
export type TaskSetLabelsToolOutput = z.infer<typeof taskSetLabelsToolOutputSchema>;

/** Simon and MCP tool contracts owned by the workspace feature (§2.1 and §10.3, §8.7, §14.6). */
export const workspaceTools = defineTools({
  task_create: { input: taskCreateToolInputSchema, output: taskCreateToolOutputSchema },
  task_move: { input: taskMoveToolInputSchema, output: taskMoveToolOutputSchema },
  label_list: { input: labelListToolInputSchema, output: labelListToolOutputSchema },
  label_create: { input: labelCreateToolInputSchema, output: labelCreateToolOutputSchema },
  task_set_labels: {
    input: taskSetLabelsToolInputSchema,
    output: taskSetLabelsToolOutputSchema,
  },
});

/** `task_search`: find an owned task by title when only its name is known (§2.1). */
export const taskSearchToolInputSchema = z.strictObject({
  /** Words from the task's title. Not a document search: titles only. */
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).optional(),
});
