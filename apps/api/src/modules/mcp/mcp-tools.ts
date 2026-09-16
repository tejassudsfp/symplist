import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  idSchema,
  isErrorCode,
  mcpTaskContextSchema,
  mcpTaskCreateSchema,
  mcpTaskListSchema,
  mcpTaskMessageSchema,
  mcpTaskMoveSchema,
  mcpTaskRunSchema,
  mcpTaskSearchSchema,
  taskDocumentChangesInputSchema,
  taskDocumentDiffInputSchema,
  taskDocumentHistoryInputSchema,
  taskDocumentOutlineInputSchema,
  taskDocumentReadSectionInputSchema,
  taskDocumentRestoreInputSchema,
  taskDocumentSearchInputSchema,
  taskDocumentUpdateSectionInputSchema,
} from "@symplist/contracts";
import {
  type DocumentRepository,
  DocumentTools,
  GrantRetrievalBudgets,
  type McpDocumentActor,
} from "@symplist/core/documents";
import {
  type McpGrants,
  type McpIdentity,
  McpSearchTools,
  McpSimonTools,
  McpTaskTools,
  mcpAuthorization,
} from "@symplist/core/mcp";
import type { SearchQueryService } from "@symplist/core/search";
import type { SimonRepository } from "@symplist/core/simon";
import type { TaskService } from "@symplist/core/tasks";
import { uuidv7 } from "@symplist/db";
import { type McpToolExtension, registerMcpExtensions } from "./mcp-extensions.ts";

export const MCP_TOOLS = "symplist:MCP_TOOLS";
function result(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
async function safe(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return result(await work());
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      isErrorCode(error.code)
        ? error.code
        : "internal";
    return { ...result({ error: { code } }), isError: true };
  }
}

/** Core services instantiated from infrastructure, never another feature's Nest module. */
export class McpTools {
  readonly tasks: McpTaskTools;
  readonly documents: DocumentTools;
  readonly budgets: GrantRetrievalBudgets;
  readonly search: McpSearchTools;
  readonly simon: McpSimonTools;
  constructor(
    readonly grants: McpGrants,
    tasks: TaskService,
    readonly repository: DocumentRepository,
    queries: SearchQueryService,
    simon: SimonRepository,
    accepted: () => void,
    readonly extensions: readonly McpToolExtension[] = [],
    onTaskConfirmed?: McpTaskTools["onConfirmed"],
  ) {
    this.tasks = new McpTaskTools(grants, tasks, onTaskConfirmed);
    this.search = new McpSearchTools(grants, queries);
    this.simon = new McpSimonTools(grants, simon, accepted);
    this.documents = new DocumentTools(repository);
    this.budgets = new GrantRetrievalBudgets({ now: grants.options.now });
  }

  actor(
    identity: McpIdentity,
    taskId: string,
    write = false,
    requestId = uuidv7(),
  ): McpDocumentActor {
    const grants = this.grants;
    return {
      kind: "mcp",
      userId: identity.ownerId,
      grantId: identity.id,
      scopes: identity.scopes,
      taskIds: identity.taskIds,
      requestId,
      get guards() {
        return [
          mcpAuthorization(identity, write ? "tasks:write" : "tasks:read", grants.options.now(), [
            taskId,
          ]),
        ];
      },
    };
  }

  server(identity: McpIdentity): McpServer {
    const server = new McpServer({ name: "Symplist", version: "1.0.0" });
    server.registerTool(
      "task_message_send",
      {
        description:
          "Send a task message to Simon. Approvals and user questions can only be answered in the owner's UI. Reuse requestId for an exact retry.",
        inputSchema: mcpTaskMessageSchema,
      },
      (args) => safe(() => this.simon.message(identity, args)),
    );
    server.registerTool(
      "task_run_status",
      {
        description: "Read a task run's state within this grant's task scope.",
        inputSchema: mcpTaskRunSchema,
        annotations: { readOnlyHint: true },
      },
      (args) => safe(() => this.simon.run(identity, args.runId)),
    );
    server.registerTool(
      "task_search",
      {
        description:
          "Search only tasks and content granted to this agent; results are bounded and freshly authorized.",
        inputSchema: mcpTaskSearchSchema,
        annotations: { readOnlyHint: true },
      },
      (args) => safe(() => this.search.search(identity, args)),
    );
    server.registerTool(
      "task_list",
      {
        description: "List active tasks within this grant's task scope.",
        inputSchema: mcpTaskListSchema,
        annotations: { readOnlyHint: true },
      },
      (args) => safe(() => this.tasks.list(identity, args)),
    );
    server.registerTool(
      "task_context",
      {
        description: "Task metadata and section read positions, never the full page.",
        inputSchema: mcpTaskContextSchema,
        annotations: { readOnlyHint: true },
      },
      (args) =>
        safe(async () => {
          const task = await this.tasks.context(identity, args.taskId);
          const positions = await this.documents.readPositions(
            this.actor(identity, args.taskId),
            args.taskId,
          );
          await this.grants.require(identity, "tasks:read", [args.taskId]);
          return {
            ...task,
            document: {
              ...positions,
              sections: positions.sections.slice(0, 100),
              removed: positions.removed.slice(0, 100),
            },
          };
        }),
    );
    server.registerTool(
      "task_create",
      {
        description:
          "Create in Unclassified. Requires all-task scope. Reuse requestId only for an exact retry.",
        inputSchema: mcpTaskCreateSchema,
      },
      (args) => safe(() => this.tasks.create(identity, args)),
    );
    server.registerTool(
      "task_move",
      {
        description:
          "Move a task and its whole subtree. Every affected task must be in scope. Reuse requestId for an exact retry.",
        inputSchema: mcpTaskMoveSchema,
      },
      (args) => safe(() => this.tasks.move(identity, args)),
    );
    server.registerTool(
      "task_document_outline",
      { inputSchema: taskDocumentOutlineInputSchema, annotations: { readOnlyHint: true } },
      (args) =>
        this.documentCall(identity, args.taskId, () =>
          this.documents.outline(this.actor(identity, args.taskId), args),
        ),
    );
    server.registerTool(
      "task_document_search",
      { inputSchema: taskDocumentSearchInputSchema, annotations: { readOnlyHint: true } },
      (args) =>
        this.documentCall(identity, args.taskId, () =>
          this.documents.search(this.actor(identity, args.taskId), args, {
            budget: this.budgets.forGrant(identity.id),
          }),
        ),
    );
    server.registerTool(
      "task_document_read_section",
      { inputSchema: taskDocumentReadSectionInputSchema, annotations: { readOnlyHint: true } },
      (args) =>
        safe(async () => {
          const actor = this.actor(identity, args.taskId);
          const read = await this.documents.readSection(actor, args, {
            budget: this.budgets.forGrant(identity.id),
          });
          if (read.receipt)
            await this.repository.db.batch(
              this.documents.receiptStatements([read.receipt], actor.guards?.[0]),
            );
          await this.grants.require(identity, "tasks:read", [args.taskId]);
          return read.output;
        }),
    );
    server.registerTool(
      "task_document_changes",
      { inputSchema: taskDocumentChangesInputSchema, annotations: { readOnlyHint: true } },
      (args) =>
        this.documentCall(identity, args.taskId, () =>
          this.documents.changes(this.actor(identity, args.taskId), args),
        ),
    );
    server.registerTool(
      "task_document_diff",
      { inputSchema: taskDocumentDiffInputSchema, annotations: { readOnlyHint: true } },
      (args) =>
        this.documentCall(identity, args.taskId, () =>
          this.documents.diff(this.actor(identity, args.taskId), args, {
            budget: this.budgets.forGrant(identity.id),
          }),
        ),
    );
    server.registerTool(
      "task_document_history",
      { inputSchema: taskDocumentHistoryInputSchema, annotations: { readOnlyHint: true } },
      (args) =>
        this.documentCall(identity, args.taskId, () =>
          this.documents.history(this.actor(identity, args.taskId), args),
        ),
    );
    server.registerTool(
      "task_document_update_section",
      { inputSchema: taskDocumentUpdateSectionInputSchema.extend({ requestId: idSchema }) },
      ({ requestId, ...args }) =>
        this.documentCall(
          identity,
          args.taskId,
          () =>
            this.documents.updateSection(this.actor(identity, args.taskId, true, requestId), args),
          true,
        ),
    );
    server.registerTool(
      "task_document_restore",
      { inputSchema: taskDocumentRestoreInputSchema.extend({ requestId: idSchema }) },
      ({ requestId, ...args }) =>
        this.documentCall(
          identity,
          args.taskId,
          () => this.documents.restore(this.actor(identity, args.taskId, true, requestId), args),
          true,
        ),
    );
    registerMcpExtensions(server, this.grants, identity, this.extensions);
    return server;
  }

  private documentCall(
    identity: McpIdentity,
    taskId: string,
    work: () => Promise<unknown>,
    write = false,
  ) {
    return safe(async () => {
      const output = await work();
      // Object and Git reads may outlive a revocation. Never return their content on stale authority.
      await this.grants.require(identity, write ? "tasks:write" : "tasks:read", [taskId]);
      return output;
    });
  }
}
