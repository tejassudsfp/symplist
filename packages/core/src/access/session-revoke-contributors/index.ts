import { connectionsSessionRevokeContributor } from "./connections.ts";
import type { SessionRevokeContributor } from "./types.ts";
import { vaultSessionRevokeContributor } from "./vault.ts";

export type { SessionRevokeContributor, SessionRevokeInput } from "./types.ts";

/** Every domain's contribution to login-session revocation, in batch order (§5.1). */
export const sessionRevokeContributors: readonly SessionRevokeContributor[] = [
  vaultSessionRevokeContributor,
  connectionsSessionRevokeContributor,
];
