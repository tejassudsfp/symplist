import { int, sql } from "@symplist/db";
import { restrictGuard } from "../sql.ts";
import type { RestrictContributor } from "./types.ts";

/**
 * Access restriction statements (§5.5). The state change itself (`beta_state = 'relocked'` or
 * `suspended_at`, with `access_generation + 1`) is the restriction's deciding statement, or account
 * deletion's statement 1 (§5.6), so this domain contributes no second `UPDATE users`. It revokes the
 * account's current beta access grants, only those of the campaign for a campaign revocation, guarded
 * by the restriction's users-row write id so nothing is revoked when the restriction did not apply.
 * A revoked grant is never revived: restores insert a new grant (§5.5 "Restore never revives").
 */
export const accessRestrictContributor: RestrictContributor = {
  domain: "access",
  statements: (input) => {
    const guard = restrictGuard(input);
    const campaign = input.reason === "campaign_revoked" && input.campaignId !== undefined;
    return [
      sql(
        `UPDATE beta_access_grants
         SET revoked_at = CAST(:now AS INTEGER), revoked_reason = :reason, write_id = :restrict_write_id
         WHERE user_id = :restrict_user AND revoked_at IS NULL
           ${campaign ? "AND campaign_id = :campaign" : ""}
           AND ${guard.exists}`,
        {
          ...guard.params,
          now: int(input.now),
          reason: input.reason,
          ...(campaign ? { campaign: input.campaignId } : {}),
        },
      ),
    ];
  },
};
