import type { McpServer } from "@modelcontextprotocol/server";
import { idSchema, isErrorCode } from "@symplist/contracts";
import { McpError, type McpGrants, type McpIdentity, mcpAuthorization } from "@symplist/core/mcp";
import { uuidv7 } from "@symplist/db";
import type { SqlGuard } from "@symplist/docs";
import type { z } from "zod";

export interface McpServiceActor {
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
          kind: "mcp",
          ownerId: identity.ownerId,
          userId: identity.ownerId,
          grantId: identity.id,
          requestId: `mcp:${identity.id}:${requestId}`,
          taskIds: identity.taskIds,
          scopes: identity.scopes,
          get guards() {
            return [mcpAuthorization(identity, scope, grants.options.now(), [taskId])];
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
