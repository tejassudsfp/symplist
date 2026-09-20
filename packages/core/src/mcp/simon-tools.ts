import { mcpTaskMessageSchema } from "@symplist/contracts";
import type { z } from "zod";
import type { SimonRepository } from "../simon/repository.ts";
import { type McpGrants, mcpAuthorization } from "./grants.ts";
import { McpError, type McpIdentity } from "./types.ts";
import { mcpWriteFold } from "./write-fold.ts";

/** Admission only: this adapter never imports a model/provider or executes the Simon loop. */
export class McpSimonTools {
  constructor(
    readonly grants: McpGrants,
    readonly simon: SimonRepository,
    readonly accepted: () => void,
  ) {}
  async message(identity: McpIdentity, input: z.input<typeof mcpTaskMessageSchema>) {
    const args = mcpTaskMessageSchema.parse(input);
    const authorization = mcpAuthorization(
      identity,
      "ai:run",
      this.grants.options.now(),
      [args.taskId],
      "simon_auth_",
    );
    const conversationId = await this.simon.createConversation(identity.ownerId, args.taskId, {
      ...mcpWriteFold(this.grants, identity, "task_conversation", args.taskId, {
        taskId: args.taskId,
      }),
      authorization,
    });
    const result = await this.simon.acceptMessage(
      identity.ownerId,
      conversationId,
      `mcp:${identity.id}:${args.requestId}`,
      { text: args.text, tier: args.tier },
      {
        ...mcpWriteFold(this.grants, identity, "task_message_send", args.requestId, args),
        authorization: mcpAuthorization(
          identity,
          "ai:run",
          this.grants.options.now(),
          [args.taskId],
          "simon_auth_",
        ),
      },
    );
    this.accepted();
    return { ...result, conversationId };
  }
  async run(identity: McpIdentity, runId: string) {
    const guard = mcpAuthorization(
      identity,
      "ai:run",
      this.grants.options.now(),
      [],
      "simon_auth_",
    );
    const run = await this.simon.run(identity.ownerId, runId, {
      sql: `${guard.sql}
      AND runs.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM tasks WHERE id = runs.task_id AND owner_id = :simon_auth_user AND status = 'active')
      AND EXISTS (SELECT 1 FROM mcp_grants g WHERE g.id = :simon_auth_grant AND (g.task_ids IS NULL OR EXISTS (SELECT 1 FROM json_each(g.task_ids) t WHERE t.value = runs.task_id)))`,
      params: guard.params,
    });
    if (!run) throw new McpError("mcp.not_found");
    return {
      runId: run.id,
      taskId: run.taskId,
      status: run.status,
      approvalRequired: run.status === "awaiting_approval",
      userReplyRequired: run.status === "awaiting_user",
    };
  }
}
