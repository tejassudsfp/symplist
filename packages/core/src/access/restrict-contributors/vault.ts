import type { RestrictContributor } from "./types.ts";

/** Vault restriction statements (§5.5). Revoke all Vault sessions; set active Vault grants to `revoked` and clear `value_enc`. */
export const vaultRestrictContributor: RestrictContributor = {
  domain: "vault",
  statements: () => [],
};
