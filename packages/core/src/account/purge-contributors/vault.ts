import type { PurgeContributor } from "./types.ts";

/** Vault purge statements (§5.6). Vaults, items, sessions, reset authorizations, unlock limits and grants. */
export const vaultPurgeContributor: PurgeContributor = {
  domain: "vault",
  statements: () => [],
};
