import type { RestrictContributor } from "./types.ts";

/** MCP restriction statements (§5.5). Revoke all MCP grants and OAuth refresh tokens; expire pending OAuth requests and unused codes. */
export const mcpRestrictContributor: RestrictContributor = {
  domain: "mcp",
  statements: (input) => {
    const guard = restrictGuard(input);
    const params = {
      owner: input.userId,
      now: int(input.now),
      write: input.writeId,
      ...guard.params,
    };
    return [
      sql(
        `UPDATE mcp_grants SET revoked_at = :now, generation = generation + 1, write_id = :write WHERE owner_id = :owner AND revoked_at IS NULL AND ${guard.exists}`,
        params,
      ),
      sql(
        `UPDATE oauth_requests SET expires_at = MIN(expires_at,:now), write_id = :write WHERE owner_id = :owner AND decided_at IS NULL AND ${guard.exists}`,
        params,
      ),
      sql(
        `UPDATE oauth_codes SET expires_at = MIN(expires_at,:now), write_id = :write WHERE owner_id = :owner AND consumed_at IS NULL AND ${guard.exists}`,
        params,
      ),
      sql(
        `UPDATE oauth_refresh_tokens SET expires_at = MIN(expires_at,:now), write_id = :write WHERE owner_id = :owner AND ${guard.exists}`,
        params,
      ),
    ];
  },
};

import { int, sql } from "@symplist/db";
import { restrictGuard } from "../sql.ts";
