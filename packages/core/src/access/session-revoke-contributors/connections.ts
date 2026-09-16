import { int, sql } from "@symplist/db";
import type { SessionRevokeContributor } from "./types.ts";

/** A callback from a logged-out session must never complete an outstanding connect attempt. */
export const connectionsSessionRevokeContributor: SessionRevokeContributor = {
  domain: "connections",
  statements: (input) => [
    sql(
      `UPDATE connection_attempts SET status = 'expired', updated_at = :now
    WHERE user_id = :owner AND status IN ('starting', 'pending', 'completing')
    ${input.sessionId ? "AND auth_session_id = :session" : ""}
    ${input.guard ? `AND ${input.guard.exists}` : ""}`,
      {
        now: int(input.now),
        owner: input.userId,
        ...(input.sessionId ? { session: input.sessionId } : {}),
        ...input.guard?.params,
      },
    ),
  ],
};
