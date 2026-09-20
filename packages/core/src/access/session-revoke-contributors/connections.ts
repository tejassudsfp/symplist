import { int, sql, uuidv7 } from "@symplist/db";
import type { SessionRevokeContributor } from "./types.ts";

/** A callback from a logged-out session must never complete an outstanding connect attempt. */
export const connectionsSessionRevokeContributor: SessionRevokeContributor = {
  domain: "connections",
  statements: (input) => [
    sql(
      `UPDATE connection_attempts SET status = 'expired', updated_at = :now, write_id = :connection_write
    WHERE user_id = :owner AND status IN ('starting', 'pending', 'completing')
    ${input.sessionId ? "AND auth_session_id = :session" : ""}
    ${input.guard ? `AND ${input.guard.exists}` : ""}`,
      {
        now: int(input.now),
        connection_write: uuidv7(input.now),
        owner: input.userId,
        ...(input.sessionId ? { session: input.sessionId } : {}),
        ...input.guard?.params,
      },
    ),
  ],
};
