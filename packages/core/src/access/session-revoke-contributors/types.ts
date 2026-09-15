import type { Statement } from "@symplist/db";
import type { CoreDomain } from "../../domains.ts";

export interface SessionRevokeInput {
  readonly userId: string;
  /** The revoked auth session, or null when every session of the user is revoked. */
  readonly sessionId: string | null;
  readonly now: number;
}

/**
 * A domain's statements appended to a login-session revocation batch (§5.1): logout and session
 * revocation also end what is bound to that session, such as its Vault session (§11.1). Statements
 * are idempotent, never update `users` or `auth_sessions`, and target only rows bound to the input.
 */
export interface SessionRevokeContributor {
  readonly domain: CoreDomain;
  statements(input: SessionRevokeInput): readonly Statement[];
}
