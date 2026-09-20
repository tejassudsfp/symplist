import { int, sql, uuidv7 } from "@symplist/db";
import type { SessionRevokeContributor } from "./types.ts";

export const mcpSessionRevokeContributor: SessionRevokeContributor = {
  domain: "mcp",
  statements: (input) => [
    sql(
      `UPDATE oauth_requests SET expires_at = MIN(expires_at,:now), write_id = :mcp_write
    WHERE owner_id = :owner AND decided_at IS NULL ${input.sessionId ? "AND auth_session_id = :session" : ""} ${input.guard ? `AND ${input.guard.exists}` : ""}`,
      {
        now: int(input.now),
        mcp_write: uuidv7(input.now),
        owner: input.userId,
        ...(input.sessionId ? { session: input.sessionId } : {}),
        ...input.guard?.params,
      },
    ),
  ],
};
