import { int, sql, uuidv7 } from "@symplist/db";
import type { SessionRevokeContributor } from "./types.ts";

/** Vault session revocation statements (§5.1, §11.1). Revoke the Vault sessions bound to the revoked auth session, or all of the user's Vault sessions. */
export const vaultSessionRevokeContributor: SessionRevokeContributor = {
  domain: "vault",
  statements: (input) => [
    sql(
      `UPDATE vault_sessions SET revoked_at=:now,write_id=:w WHERE owner_id=:owner AND revoked_at IS NULL ${input.sessionId ? "AND auth_session_id=:session" : ""} ${input.guard ? `AND ${input.guard.exists}` : ""}`,
      {
        ...input.guard?.params,
        owner: input.userId,
        now: int(input.now),
        w: uuidv7(input.now),
        ...(input.sessionId ? { session: input.sessionId } : {}),
      },
    ),
  ],
};
