import type { AccessState } from "@symplist/contracts";

/**
 * Access levels, access-state enums and the restriction reasons are browser-safe contracts, so the
 * web app and every runtime share one definition (§5.4, §5.5).
 */
export type {
  AccessLevel,
  AccessState,
  BetaState,
  DeletionState,
  OnboardingStep,
  RestrictionReason,
  UserRole,
} from "@symplist/contracts";

/** The trusted identity behind a request, socket or run step. */
export interface SessionContext {
  readonly userId: string;
  /** The auth session id; Vault sessions, OAuth requests and connect attempts bind to it. */
  readonly sessionId: string;
  readonly access: AccessState;
}
