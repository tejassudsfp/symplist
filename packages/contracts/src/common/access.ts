import { z } from "zod";
import { counterSchema, epochMillisSchema } from "./primitives.ts";

/**
 * Guard levels (§5.4): `identity` needs a live session and no deletion in progress, `admitted` adds
 * verified, unlocked, not suspended and not relocked, and `admin` adds the admin role.
 */
export const accessLevels = ["identity", "admitted", "admin"] as const;
export const accessLevelSchema = z.enum(accessLevels);
export type AccessLevel = z.infer<typeof accessLevelSchema>;

/** Beta admission (§5.4). `relocked` returns to `locked` only through Restore eligibility. */
export const betaStates = ["locked", "unlocked", "relocked"] as const;
export const betaStateSchema = z.enum(betaStates);
export type BetaState = z.infer<typeof betaStateSchema>;

export const onboardingSteps = ["name", "connections", "done"] as const;
export const onboardingStepSchema = z.enum(onboardingSteps);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

export const userRoles = ["member", "admin"] as const;
export const userRoleSchema = z.enum(userRoles);
export type UserRole = z.infer<typeof userRoleSchema>;

export const deletionStates = ["none", "deleting"] as const;
export const deletionStateSchema = z.enum(deletionStates);
export type DeletionState = z.infer<typeof deletionStateSchema>;

/** The only reasons access is taken away, each through `core/access.restrict` (§5.5). */
export const restrictionReasons = ["relocked", "suspended", "deleted", "campaign_revoked"] as const;
export const restrictionReasonSchema = z.enum(restrictionReasons);
export type RestrictionReason = z.infer<typeof restrictionReasonSchema>;

/**
 * The independent access fields on `users` (§5.4). Timestamps are UTC epoch milliseconds. These are
 * plaintext operational metadata (§4.4).
 */
export const accessStateSchema = z.strictObject({
  emailVerifiedAt: epochMillisSchema.nullable(),
  betaState: betaStateSchema,
  suspendedAt: epochMillisSchema.nullable(),
  onboardingStep: onboardingStepSchema,
  role: userRoleSchema,
  /** Incremented by every restriction and restore; carried by access caches (§3.3). */
  accessGeneration: counterSchema,
  /** Incremented by Restore eligibility so a new invite can be redeemed. */
  accessEpoch: counterSchema,
  deletionState: deletionStateSchema,
});

export type AccessState = Readonly<z.infer<typeof accessStateSchema>>;
