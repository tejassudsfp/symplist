/** Guard levels (§5.4): `identity` needs a live session, `admitted` full beta access, `admin` the role. */
export type AccessLevel = "identity" | "admitted" | "admin";

export type BetaState = "locked" | "unlocked" | "relocked";
export type OnboardingStep = "name" | "connections" | "done";
export type UserRole = "member" | "admin";
export type DeletionState = "none" | "deleting";

/** The independent access fields on `users` (§5.4). Timestamps are UTC epoch milliseconds. */
export interface AccessState {
  readonly emailVerifiedAt: number | null;
  readonly betaState: BetaState;
  readonly suspendedAt: number | null;
  readonly onboardingStep: OnboardingStep;
  readonly role: UserRole;
  /** Incremented by every restriction and restore; carried by access caches (§3.3). */
  readonly accessGeneration: number;
  /** Incremented by Restore eligibility so a new invite can be redeemed. */
  readonly accessEpoch: number;
  readonly deletionState: DeletionState;
}

/** The trusted identity behind a request, socket or run step. */
export interface SessionContext {
  readonly userId: string;
  /** The auth session id; Vault sessions, OAuth requests and connect attempts bind to it. */
  readonly sessionId: string;
  readonly access: AccessState;
}

/** The only reasons access is taken away (§5.5). */
export type RestrictionReason = "relocked" | "suspended" | "deleted" | "campaign_revoked";
