import type { McpServer } from "@modelcontextprotocol/server";
import {
  idSchema,
  isErrorCode,
  mcpTaskScheduleSchema,
  sharingTools,
  taskScheduleToolInputSchema,
} from "@symplist/contracts";
import {
  McpError,
  type McpGrants,
  type McpIdentity,
  mcpAuthorization,
  mcpWriteFold,
} from "@symplist/core/mcp";
import { type SchedulingService, taskScheduleTool } from "@symplist/core/scheduling";
import { type SharingFold, SharingGrants, type SharingRepository } from "@symplist/core/sharing";
import { sql, uuidv7 } from "@symplist/db";
import type { SqlGuard } from "@symplist/docs";
import type { z } from "zod";

export interface McpServiceActor {
  readonly identity: McpIdentity;
  readonly kind: "mcp";
  readonly ownerId: string;
  readonly userId: string;
  readonly grantId: string;
  readonly requestId: string;
  readonly taskIds: readonly string[] | null;
  readonly scopes: readonly string[];
  /** Getter-backed: a service obtains a fresh clock when compiling its deciding predicate. */
  readonly guards: readonly SqlGuard[];
}

/** Only these cross-feature seams may extend incoming MCP; never Simon proposals or Vault tools. */
export interface McpToolExtension {
  readonly name:
    | "task_schedule"
    | "artifact_snapshot"
    | "artifact_share_list"
    | "artifact_share_revoke";
  /** The owning contracts schema, extended with a requestId for mutations by the runtime adapter. */
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
  /** Pure operation classification; schedule 'read' and share_list are read-only. */
  readonly writes: (input: Record<string, unknown>) => boolean;
  /** Derive from owned persisted artifact/grant rows when the input does not directly name a task. */
  readonly task: (ownerId: string, input: Record<string, unknown>) => Promise<string>;
  /** Must use these guards in the core write and replay, never just the pre-read. */
  readonly execute: (actor: McpServiceActor, input: Record<string, unknown>) => Promise<unknown>;
}

/** Concrete feature services share infrastructure, never feature Nest module imports. */
export function mcpFeatureExtensions(
  grants: McpGrants,
  scheduling: SchedulingService,
  sharing: SharingRepository,
): readonly McpToolExtension[] {
  const shares = new SharingGrants(sharing);
  const task = async (_owner: string, input: Record<string, unknown>) =>
    idSchema.parse(input.taskId);
  return [
    {
      name: "task_schedule",
      inputSchema: mcpTaskScheduleSchema,
      writes: (input) => input.operation !== "read",
      task,
      execute: (actor, { requestId: _requestId, ...input }) =>
        taskScheduleTool(scheduling, actor, taskScheduleToolInputSchema.parse(input)),
    },
    {
      name: "artifact_snapshot",
      inputSchema: sharingTools.artifact_snapshot.input.extend({ requestId: idSchema }),
      writes: () => true,
      task,
      execute: (actor, { requestId: _requestId, ...input }) => {
        const { taskId, ...snapshot } = sharingTools.artifact_snapshot.input.parse(input);
        return sharing.snapshot(actor, taskId, snapshot, actor.requestId);
      },
    },
    {
      name: "artifact_share_list",
      inputSchema: sharingTools.artifact_share_list.input,
      writes: () => false,
      task,
      execute: (actor, input) => {
        const { taskId, ...query } = sharingTools.artifact_share_list.input.parse(input);
        return sharing.list(actor, taskId, query);
      },
    },
    {
      name: "artifact_share_revoke",
      inputSchema: sharingTools.artifact_share_revoke.input.extend({ requestId: idSchema }),
      writes: () => true,
      task: async (owner, input) => {
        const row = await sharing.options.db.first(
          sql(
            "SELECT task_id FROM artifacts WHERE id = :artifact AND owner_id = :owner AND deleted_at IS NULL",
            {
              artifact: idSchema.parse(input.artifactId),
              owner,
            },
          ),
        );
        if (!row) throw new McpError("mcp.not_found");
        return String(row.task_id);
      },
      execute: (actor, { requestId: _requestId, ...input }) => {
        const args = sharingTools.artifact_share_revoke.input.parse(input);
        const fold = mcpWriteFold(
          grants,
          actor.identity,
          "artifact_share_revoke",
          actor.requestId,
          args,
        );
        const sharingFold: SharingFold = {
          prefix: fold.statements,
          guard: { sql: fold.claim.guard.exists, params: fold.claim.guard.params },
          complete: (body, key, effect) => {
            const completion = fold.completion({ status: 200, body }, key);
            const proof = sql(effect.sql, effect.params);
            const authority = sharing.guards(sharing.access(actor.ownerId), ...actor.guards);
            return [
              {
                sql: `${completion.sql} AND (${proof.sql})`,
                params: [...completion.params, ...proof.params],
              },
              sql(
                `DELETE FROM idempotency_records WHERE scope = :idem_scope AND user_id = :idem_user AND key = :idem_key AND write_id = :idem_write_id AND status = 'pending' AND NOT (${effect.sql})`,
                { ...fold.claim.guard.params, ...effect.params },
              ),
              sql(`SELECT 1 AS authorized WHERE ${authority.sql}`, authority.params),
            ];
          },
          decide: (results, key) => {
            if (!results.at(-2)?.results[0]?.authorized) throw new McpError("mcp.forbidden");
            const decision = fold.decide(results, key, 0);
            return decision.kind === "replay" ? { replay: decision.body } : null;
          },
        };
        return shares.revoke(actor, args.artifactId, args.grantId, sharingFold);
      },
    },
  ];
}

const allowed = new Set([
  "task_schedule",
  "artifact_snapshot",
  "artifact_share_list",
  "artifact_share_revoke",
]);
export function registerMcpExtensions(
  server: McpServer,
  grants: McpGrants,
  identity: McpIdentity,
  extensions: readonly McpToolExtension[],
): void {
  const seen = new Set<string>();
  for (const extension of extensions) {
    if (!allowed.has(extension.name) || seen.has(extension.name))
      throw new Error("mcp.invalid_extension");
    seen.add(extension.name);
    server.registerTool(extension.name, { inputSchema: extension.inputSchema }, async (input) => {
      try {
        const write = extension.writes(input);
        const requestId = write ? idSchema.parse(input.requestId) : uuidv7();
        const scope = write ? "tasks:write" : "tasks:read";
        await grants.require(identity, scope, []);
        const taskId = await extension.task(identity.ownerId, input);
        if (!idSchema.safeParse(taskId).success) throw new McpError("mcp.not_found");
        await grants.require(identity, scope, [taskId]);
        const actor: McpServiceActor = {
          identity,
          kind: "mcp",
          ownerId: identity.ownerId,
          userId: identity.ownerId,
          grantId: identity.id,
          requestId: `mcp:${identity.id}:${requestId}`,
          taskIds: identity.taskIds,
          scopes: identity.scopes,
          get guards() {
            const guard = mcpAuthorization(identity, scope, grants.options.now(), [taskId]);
            return [
              {
                sql: `${guard.sql} AND EXISTS (SELECT 1 FROM tasks WHERE id = :mcp_ext_task AND owner_id = :mcp_ext_owner${write ? " AND status = 'active'" : ""})`,
                params: { ...guard.params, mcp_ext_task: taskId, mcp_ext_owner: identity.ownerId },
              },
            ];
          },
        };
        const output = await extension.execute(actor, input);
        // Also fence read results returned after object-store/Git/network work.
        await grants.require(identity, scope, [taskId]);
        return { content: [{ type: "text", text: JSON.stringify(output) }] };
      } catch (error) {
        const code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string" &&
          isErrorCode(error.code)
            ? error.code
            : "internal";
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: { code } }) }],
        };
      }
    });
  }
}
