import { int, sql } from "@symplist/db";
import { restrictGuard } from "../sql.ts";
import type { RestrictContributor } from "./types.ts";

/** Connections restriction statements (§5.5). Expire pending connection attempts. */
export const connectionsRestrictContributor: RestrictContributor = {
  domain: "connections",
  statements: (input) => {
    const guard = restrictGuard(input);
    return [
      sql(
        `UPDATE connection_attempts SET status = 'expired', updated_at = :now, write_id = :write
      WHERE user_id = :owner AND status IN ('starting', 'pending', 'completing') AND ${guard.exists}`,
        {
          now: int(input.now),
          write: input.writeId,
          owner: input.userId,
          ...guard.params,
        },
      ),
    ];
  },
};
