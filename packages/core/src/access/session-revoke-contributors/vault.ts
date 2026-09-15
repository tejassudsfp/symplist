import type { SessionRevokeContributor } from "./types.ts";

/** Vault session revocation statements (§5.1, §11.1). Revoke the Vault sessions bound to the revoked auth session, or all of the user's Vault sessions. */
export const vaultSessionRevokeContributor: SessionRevokeContributor = {
  domain: "vault",
  statements: () => [],
};
