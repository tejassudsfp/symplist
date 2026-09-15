import type { PurgeContributor } from "./types.ts";

/** MCP purge statements (§5.6). MCP grants, OAuth requests, codes and refresh tokens. */
export const mcpPurgeContributor: PurgeContributor = {
  domain: "mcp",
  statements: () => [],
};
