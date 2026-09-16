import {
  mcpTaskCreateSchema,
  mcpTaskListSchema,
  mcpTaskMoveSchema,
  type TaskDetailResponse,
  taskCreateResponseSchema,
  taskMoveResponseSchema,
} from "@symplist/contracts";
import type { z } from "zod";
import { sourceKind, type TaskRecord } from "../tasks/model.ts";
import type { TaskService, TaskWriteFold } from "../tasks/service.ts";
import { type McpGrants, mcpAuthorization } from "./grants.ts";
import { McpError, type McpIdentity } from "./types.ts";
import { mcpWriteFold } from "./write-fold.ts";

export class McpTaskTools {
  constructor(
    readonly grants: McpGrants,
    readonly tasks: TaskService,
  ) {}

  async context(identity: McpIdentity, taskId: string) {
    const guard = mcpAuthorization(
      identity,
      "tasks:read",
      this.grants.options.now(),
      [taskId],
      "task_auth_",
    );
    const detail = await this.tasks.getTask(identity.ownerId, taskId, guard);
    if (detail.task.status !== "active") throw new McpError("mcp.not_found");
    return this.maskDetail(identity, detail);
  }

  private maskDetail(identity: McpIdentity, detail: TaskDetailResponse) {
    const allowed = (id: string) => identity.taskIds === null || identity.taskIds.includes(id);
    // Counts and unselected parent IDs are data too; a selected child does not grant its siblings.
    const {
      childCount: _childCount,
      parentId,
      archivedWithRootId: _archiveRoot,
      ...task
    } = detail.task;
    return {
      task: { ...task, parentId: parentId && allowed(parentId) ? parentId : null },
      ancestors: detail.ancestors.filter((item) => allowed(item.id)),
    };
  }

  async list(identity: McpIdentity, input: z.input<typeof mcpTaskListSchema>) {
    const args = mcpTaskListSchema.parse(input);
    const state = await this.tasks.state(identity.ownerId);
    const guard = mcpAuthorization(
      identity,
      "tasks:read",
      this.grants.options.now(),
      [],
      "task_auth_",
    );
    await this.tasks.authorize(identity.ownerId, guard, state.version);
    const records = [...state.tree.byId.values()]
      .filter(
        (task) =>
          (identity.taskIds === null || identity.taskIds.includes(task.id)) &&
          (!args.collection || task.collection === args.collection) &&
          (!args.cursor || task.id > args.cursor),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const window = records.slice(0, args.limit);
    return {
      tasks: window.map((task) => this.summary(identity, task)),
      nextCursor: records.length > args.limit ? (window.at(-1)?.id ?? null) : null,
    };
  }

  private summary(identity: McpIdentity, task: TaskRecord) {
    return {
      id: task.id,
      title: task.title,
      preview: task.preview,
      collection: task.collection,
      parentId:
        task.parentId && (identity.taskIds === null || identity.taskIds.includes(task.parentId))
          ? task.parentId
          : null,
      source: sourceKind(task.source),
      version: task.version,
    };
  }

  private fold(
    identity: McpIdentity,
    tool: string,
    requestId: string,
    input: unknown,
  ): TaskWriteFold {
    return mcpWriteFold(this.grants, identity, tool, requestId, input);
  }

  async create(identity: McpIdentity, input: z.input<typeof mcpTaskCreateSchema>) {
    const args = mcpTaskCreateSchema.parse(input);
    const authorization = mcpAuthorization(
      identity,
      "tasks:write",
      this.grants.options.now(),
      null,
      "task_auth_",
    );
    const result = await this.tasks.create({
      ownerId: identity.ownerId,
      actor: { kind: "mcp", grantId: identity.id },
      title: args.title,
      ...(args.parentTaskId ? {} : { collection: "unclassified" as const }),
      ...(args.parentTaskId ? { parentId: args.parentTaskId } : {}),
      authorization,
      fold: this.fold(identity, "task_create", args.requestId, args),
    });
    const { task } = taskCreateResponseSchema.parse(result.body);
    return {
      taskId: task.id,
      collection: task.collection,
      parentTaskId: task.parentId,
      created: result.kind === "applied",
    };
  }

  async move(identity: McpIdentity, input: z.input<typeof mcpTaskMoveSchema>) {
    const args = mcpTaskMoveSchema.parse(input);
    const guard = mcpAuthorization(
      identity,
      "tasks:write",
      this.grants.options.now(),
      [args.taskId],
      "task_auth_",
    );
    const authorization = {
      sql: `${guard.sql} AND NOT EXISTS (
      WITH RECURSIVE subtree(id) AS (SELECT id FROM tasks WHERE id = :task_auth_target AND owner_id = :task_auth_user AND status = 'active'
        UNION SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id WHERE t.owner_id = :task_auth_user AND t.status = 'active')
      SELECT 1 FROM subtree JOIN mcp_grants g ON g.id = :task_auth_grant WHERE g.task_ids IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(g.task_ids) a WHERE a.value = subtree.id))`,
      params: { ...guard.params, task_auth_target: args.taskId },
    };
    const result = await this.tasks.move({
      ownerId: identity.ownerId,
      actor: { kind: "mcp", grantId: identity.id },
      taskId: args.taskId,
      collection: args.collection,
      parentId: null,
      authorization,
      fold: this.fold(identity, "task_move", args.requestId, args),
    });
    const body = taskMoveResponseSchema.parse(result.body);
    return {
      taskId: body.taskId,
      collection: body.collection,
      parentTaskId: body.parentId,
      movedTaskIds: body.movedTaskIds,
    };
  }
}
