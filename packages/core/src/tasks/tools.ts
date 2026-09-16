import {
  type TaskCreateToolOutput,
  type TaskMoveToolOutput,
  taskCreateToolInputSchema,
  taskIdSchema,
  taskMoveToolInputSchema,
} from "@symplist/contracts";
import type { z } from "zod";
import type { TaskAuthorization } from "./authorization.ts";
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
 *
 * The create is attempted first and the task is only looked up when it is refused. Probing for the
 * tool's own id up front cost a D1 read on every call — always a miss, because the id is new — so a
 * first-time create cost two requests where the write's own id condition already decides it (§3 write
 * -id verification, decision WS18).
 */
export async function taskCreateTool(
  service: TaskService,
  input: {
    readonly ownerId: string;
    readonly actor: TaskToolActor;
    readonly arguments: z.input<typeof taskCreateToolInputSchema>;
    /** A UUIDv7 derived from the tool call, stable across retries. */
    readonly taskId: string;
    readonly authorization?: TaskAuthorization;
  },
): Promise<TaskCreateToolOutput> {
  const args = taskCreateToolInputSchema.parse(input.arguments);
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
      ...(input.authorization ? { authorization: input.authorization } : {}),
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
    // The refusal a retry gets: its first attempt committed, so the id is taken. Every other
    // refusal (an archived parent, paused access) finds no task and is passed on unchanged.
    const found = await findOwn(service, input.ownerId, input.taskId, input.authorization);
    if (found) return found;
    throw error;
  }
}

async function findOwn(
  service: TaskService,
  ownerId: string,
  taskId: string,
  authorization?: TaskAuthorization,
): Promise<TaskCreateToolOutput | null> {
  try {
    const { task } = await service.getTask(
      ownerId,
      taskId,
      authorization ?? { sql: "1 = 1", params: {} },
    );
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
    readonly authorization?: TaskAuthorization;
  },
): Promise<TaskMoveToolOutput> {
  const args = taskMoveToolInputSchema.parse(input.arguments);
  const { task } = await service.getTask(input.ownerId, args.taskId, input.authorization);
  if (task.status === "archived") throw new TaskOperationError("task.archived");
  if (task.collection === args.collection && task.parentId === null) {
    const state = await service.state(input.ownerId);
    const current = state.tree.get(task.id);
    const moved = [
      task.id,
      ...state.tree.descendantsOf(task.id).map((child) => taskIdSchema.parse(child.id)),
    ];
    // The public list is paginated: it cannot stand in for this complete subtree. The version
    // witness also prevents a cached, formerly authorized subtree leaking after a concurrent move.
    await service.authorize(input.ownerId, input.authorization, state.version);
    if (
      !current ||
      current.collection !== args.collection ||
      state.tree.effectiveParent(current) !== null
    )
      throw new TaskOperationError("task.conflict");
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
    ...(input.authorization ? { authorization: input.authorization } : {}),
  });
  if (result.kind !== "applied") throw new TaskOperationError("task.conflict");
  return {
    taskId: result.body.taskId,
    collection: result.body.collection,
    parentTaskId: result.body.parentId,
    movedTaskIds: result.body.movedTaskIds,
  };
}
