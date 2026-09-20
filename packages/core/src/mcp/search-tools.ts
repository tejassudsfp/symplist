import { mcpTaskSearchSchema } from "@symplist/contracts";
import { sql } from "@symplist/db";
import type { z } from "zod";
import { requestSearchIndex, type SearchQueryService } from "../search/index.ts";
import { type McpGrants, mcpAuthorization } from "./grants.ts";
import { McpError, type McpIdentity } from "./types.ts";

export class McpSearchTools {
  constructor(
    readonly grants: McpGrants,
    readonly queries: SearchQueryService,
  ) {}
  async search(identity: McpIdentity, input: z.input<typeof mcpTaskSearchSchema>) {
    const args = mcpTaskSearchSchema.parse(input);
    const targets = args.taskId ? [args.taskId] : [];
    const guard = mcpAuthorization(identity, "tasks:read", this.grants.options.now(), targets);
    const row = await this.grants.options.db.first(
      sql(
        `SELECT access_generation FROM users WHERE id = :owner AND ${this.grants.access()} AND ${guard.sql}`,
        { ...guard.params, owner: identity.ownerId },
      ),
    );
    if (!row) throw new McpError("mcp.forbidden");
    const result = await this.queries.search(
      {
        userId: identity.ownerId,
        accessGeneration: Number(row.access_generation),
        taskScope: identity.taskIds === null ? null : new Set(identity.taskIds),
      },
      {
        q: args.query,
        archive: "exclude",
        ...(args.taskId ? { taskId: args.taskId } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        limit: args.limit,
      },
    );
    await this.grants.require(identity, "tasks:read", targets);
    if (result.indexing)
      requestSearchIndex(this.grants.options.db, {
        ownerId: identity.ownerId,
        reason: result.indexing,
      });
    return result.response;
  }
}
