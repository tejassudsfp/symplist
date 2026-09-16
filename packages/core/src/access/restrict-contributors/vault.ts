import { int, sql } from "@symplist/db";
import { restrictGuard } from "../sql.ts";
import type { RestrictContributor } from "./types.ts";

/** Vault restriction statements (§5.5). Revoke all Vault sessions; set active Vault grants to `revoked` and clear `value_enc`. */
export const vaultRestrictContributor: RestrictContributor = {
  domain: "vault",
  statements: (input) => {
    const guard = restrictGuard(input);
    const params = { ...guard.params, owner: input.userId, now: int(input.now), w: input.writeId };
    return [
      sql(
        `UPDATE vault_sessions SET revoked_at=:now,write_id=:w WHERE owner_id=:owner AND revoked_at IS NULL AND ${guard.exists}`,
        params,
      ),
      sql(
        `UPDATE vault_grants SET status='revoked',value_enc=NULL,write_id=:w WHERE owner_id=:owner AND status='active' AND ${guard.exists}`,
        { ...guard.params, owner: input.userId, w: input.writeId },
      ),
    ];
  },
};
