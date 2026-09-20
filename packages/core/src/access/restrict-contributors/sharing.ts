import { int, sql } from "@symplist/db";
import { restrictGuard } from "../sql.ts";
import type { RestrictContributor } from "./types.ts";

/** Sharing restriction statements (§5.5). Disable active share grants with the reason and `generation + 1`, revoke share sessions and expire pending share approvals. */
export const sharingRestrictContributor: RestrictContributor = {
  domain: "sharing",
  statements: (input) => {
    const guard = restrictGuard(input);
    return [
      sql(
        `UPDATE share_grants SET status = 'disabled', disabled_reason = :reason, generation = generation + 1, write_id = :restrict_write_id WHERE owner_id = :restrict_user AND status = 'active' AND ${guard.exists}`,
        { ...guard.params, reason: input.reason },
      ),
      sql(
        `UPDATE share_sessions SET revoked_at = :now, write_id = :restrict_write_id WHERE owner_id = :restrict_user AND revoked_at IS NULL AND ${guard.exists}`,
        { ...guard.params, now: int(input.now) },
      ),
      sql(
        `UPDATE share_approvals SET status = 'expired', write_id = :restrict_write_id WHERE owner_id = :restrict_user AND status = 'pending' AND ${guard.exists}`,
        guard.params,
      ),
    ];
  },
};
