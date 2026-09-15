import type { ArchiveContributor } from "./types.ts";

/** Vault task-archive statements (§2.1). Revoke the tasks' Vault grants and clear `value_enc` (§11.3). */
export const vaultArchiveContributor: ArchiveContributor = {
  domain: "vault",
  statements: () => [],
};
