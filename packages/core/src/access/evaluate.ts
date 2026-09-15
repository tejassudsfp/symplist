import type { AccessLevel, AccessState, BetaState } from "./types.ts";

/** Deployment policy that changes how access state is read (§5.4). */
export interface AccessPolicy {
  /** `BETA_ACCESS_REQUIRED`: when false, verified, non-suspended, non-relocked accounts are unlocked. */
  readonly betaAccessRequired: boolean;
}

/** The stable error code a failed access check returns (§5.4, §6). */
export type AccessDenialCode =
  | "auth.session_required"
  | "access.unverified"
  | "access.suspended"
  | "access.relocked"
  | "access.locked"
  | "access.admin_required";

export type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: AccessDenialCode };

const allowed: AccessDecision = Object.freeze({ allowed: true });

function deny(code: AccessDenialCode): AccessDecision {
  return Object.freeze({ allowed: false, code });
}

/**
 * The beta state the rest of the system acts on: with `BETA_ACCESS_REQUIRED=false` a `locked` account
 * counts as `unlocked`, while `relocked` stays relocked (§5.4).
 */
export function effectiveBetaState(state: AccessState, policy: AccessPolicy): BetaState {
  if (!policy.betaAccessRequired && state.betaState === "locked") return "unlocked";
  return state.betaState;
}

/**
 * Evaluates a guard level against the user's access fields (§5.4):
 *
 * - `identity`: a valid session (checked by the caller) and `deletion_state = 'none'`;
 * - `admitted`: adds verified, not suspended, not relocked and unlocked (or beta access not required);
 * - `admin`: adds the admin role.
 *
 * The first failing rule decides the code, in the order verified, suspended, relocked, locked, role,
 * so a suspended account never learns whether it would also be locked.
 */
export function evaluateAccess(
  state: AccessState,
  level: AccessLevel,
  policy: AccessPolicy,
): AccessDecision {
  if (state.deletionState !== "none") return deny("auth.session_required");
  if (level === "identity") return allowed;
  if (state.emailVerifiedAt === null) return deny("access.unverified");
  if (state.suspendedAt !== null) return deny("access.suspended");
  if (state.betaState === "relocked") return deny("access.relocked");
  if (effectiveBetaState(state, policy) !== "unlocked") return deny("access.locked");
  if (level === "admitted") return allowed;
  return state.role === "admin" ? allowed : deny("access.admin_required");
}

/** Whether the state satisfies a guard level. */
export function satisfiesAccess(
  state: AccessState,
  level: AccessLevel,
  policy: AccessPolicy,
): boolean {
  return evaluateAccess(state, level, policy).allowed;
}
