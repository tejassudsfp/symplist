import {
  type TaskCreateToolOutput,
  type TaskMoveToolOutput,
  taskCreateToolInputSchema,
  taskMoveToolInputSchema,
} from "@symplist/contracts";
import type { z } from "zod";
import { TaskOperationError } from "./errors.ts";
import type { TaskActor, TaskService } from "./service.ts";

/** Simon or a connected agent (§8.7, §14.6); tools never act as the user. */
export type TaskToolActor = Exclude<TaskActor, { readonly kind: "user" }>;

/**
 * `task_create` for Simon and MCP with trusted identity (§8.7, §14.6). A connected agent's top-level
 * task lands in Unclassified with `source = 'mcp:<grantId>'`; Simon's lands in the requested
 * collection, or Unclassified. A subtask inherits its parent's collection. `taskId` makes a retried
 * call (the same tool call) create the task once: a retry that finds the task it created returns it
 * with `created: false`. Access is checked inside the write batch; archived parents are refused with
 * `task.archived`.
 */
export async function taskCreateTool(
  service: TaskService,
  input: {
    readonly ownerId: string;
    readonly actor: TaskToolActor;
    readonly arguments: z.input<typeof taskCreateToolInputSchema>;
    /** A UUIDv7 derived from the tool call, stable across retries. */
    readonly taskId: string;
  },
): Promise<TaskCreateToolOutput> {
  const args = taskCreateToolInputSchema.parse(input.arguments);
  const existing = await findOwn(service, input.ownerId, input.taskId);
  if (existing) return existing;
  const collection =
    args.parentTaskId !== undefined
      ? undefined
      : input.actor.kind === "mcp"
        ? "unclassified"
        : (args.collection ?? "unclassified");
  try {
    const result = await service.create({
      ownerId: input.ownerId,
      actor: input.actor,
      title: args.title,
      taskId: input.taskId,
      ...(collection === undefined ? {} : { collection }),
      ...(args.parentTaskId === undefined ? {} : { parentId: args.parentTaskId }),
    });
    if (result.kind !== "applied") throw new TaskOperationError("task.conflict");
    const { task } = result.body;
    return {
      taskId: task.id,
      collection: task.collection,
      parentTaskId: task.parentId,
      created: true,
    };
  } catch (error) {
    // A retry whose first attempt committed without an answer finds its own task now.
    const found = await findOwn(service, input.ownerId, input.taskId);
    if (found) return found;
    throw error;
  }
}

async function findOwn(
  service: TaskService,
  ownerId: string,
  taskId: string,
): Promise<TaskCreateToolOutput | null> {
  try {
    const { task } = await service.getTask(ownerId, taskId);
    return {
      taskId: task.id,
      collection: task.collection,
      parentTaskId: task.parentId,
      created: false,
    };
  } catch (error) {
    if (error instanceof TaskOperationError && error.code === "not_found") return null;
    throw error;
  }
}

/**
 * `task_move` for Simon and MCP (§8.7, §14.6): moves a task and its subtasks to a collection. A
 * subtask becomes top level there (decision P3). Moving to the collection a top-level task is already
 * in keeps it where it is.
 */
export async function taskMoveTool(
  service: TaskService,
  input: {
    readonly ownerId: string;
    readonly actor: TaskToolActor;
    readonly arguments: z.input<typeof taskMoveToolInputSchema>;
  },
): Promise<TaskMoveToolOutput> {
  const args = taskMoveToolInputSchema.parse(input.arguments);
  const { task } = await service.getTask(input.ownerId, args.taskId);
  if (task.status === "archived") throw new TaskOperationError("task.archived");
  if (task.collection === args.collection && task.parentId === null) {
    const tree = await service.listCollection(input.ownerId, args.collection);
    const own = tree.tasks.findIndex((node) => node.id === task.id);
    const moved = [task.id];
    const baseDepth = tree.tasks[own]?.depth ?? 0;
    for (let index = own + 1; index < tree.tasks.length; index += 1) {
      const node = tree.tasks[index];
      if (!node || node.depth <= baseDepth) break;
      moved.push(node.id);
    }
    return {
      taskId: task.id,
      collection: task.collection,
      parentTaskId: null,
      movedTaskIds: moved,
    };
  }
  const result = await service.move({
    ownerId: input.ownerId,
    actor: input.actor,
    taskId: args.taskId,
    collection: args.collection,
    parentId: null,
  });
  if (result.kind !== "applied") throw new TaskOperationError("task.conflict");
  return {
    taskId: result.body.taskId,
    collection: result.body.collection,
    parentTaskId: result.body.parentId,
    movedTaskIds: result.body.movedTaskIds,
  };
}
