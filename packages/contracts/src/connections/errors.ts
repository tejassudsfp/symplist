import { defineErrorCodes } from "../common/errors.ts";

/** Stable error codes owned by the connections feature (§14, §6), mapped to HTTP statuses. */
export const connectionsErrorCodes = defineErrorCodes({
  "mcp.invalid_token": 401,
  "mcp.invalid_request": 400,
  "mcp.not_found": 404,
  "mcp.forbidden": 403,
  "mcp.conflict": 409,
  "integration.unavailable": 503,
  "integration.unauthorized": 404,
  "integration.rate_limited": 429,
  "integration.provider_failed": 502,
  "integration.uncertain": 409,
  "integration.invalid_response": 502,
  "integration.tool_unavailable": 400,
  "integration.invalid_arguments": 400,
  "integration.account_selection_required": 409,
  "integration.connection_required": 409,
});
