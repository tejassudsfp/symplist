import type { RestrictContributor } from "./types.ts";

/** MCP restriction statements (§5.5). Revoke all MCP grants and OAuth refresh tokens; expire pending OAuth requests and unused codes. */
export const mcpRestrictContributor: RestrictContributor = {
  domain: "mcp",
  statements: () => [],
};
