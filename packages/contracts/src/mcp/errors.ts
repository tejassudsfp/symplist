import { defineErrorCodes } from "../common/errors.ts";

/**
 * Stable error codes owned by the agent-access feature (§14, §6), mapped to HTTP statuses.
 *
 * The `integration.*` half of this map is gone. Those were Composio's — provider unavailable, rate
 * limited, result too large, connection required — and they described a connector action taken on the
 * owner's behalf by a server-side agent. There is no server-side agent (note 18) and no connector
 * layer, and the person's own MCP client brings its own integrations.
 */
export const mcpErrorCodes = defineErrorCodes({
  "mcp.invalid_token": 401,
  "mcp.invalid_request": 400,
  "mcp.not_found": 404,
  "mcp.forbidden": 403,
  "mcp.conflict": 409,
});
