"use client";

/**
 * The Vault's lock status beside the top bar's Vault link (§11.1). It never names items (§15).
 * Status deliberately never probes or exposes item metadata outside the Vault route group.
 */
export function VaultStatus() {
  return <span className="sr-only">Vault uses a separate key</span>;
}
