import { describe, expect, it } from "vitest";
import {
  accessLevelSchema,
  accessLevels,
  accessStateSchema,
  betaStates,
  deletionStates,
  onboardingSteps,
  restrictionReasons,
  userRoles,
} from "./access.ts";
import { analyticsConsentSchema, analyticsConsentStates } from "./consent.ts";

const state = {
  emailVerifiedAt: 1_757_900_000_000,
  betaState: "unlocked",
  suspendedAt: null,
  onboardingStep: "done",
  role: "member",
  accessGeneration: 3,
  accessEpoch: 1,
  deletionState: "none",
};

describe("access states and levels (§5.4, §5.5)", () => {
  it("defines exactly the architecture's enums", () => {
    expect(accessLevels).toEqual(["identity", "admitted", "admin"]);
    expect(betaStates).toEqual(["locked", "unlocked", "relocked"]);
    expect(onboardingSteps).toEqual(["name", "connections", "done"]);
    expect(userRoles).toEqual(["member", "admin"]);
    expect(deletionStates).toEqual(["none", "deleting"]);
    expect(restrictionReasons).toEqual(["relocked", "suspended", "deleted", "campaign_revoked"]);
    expect(accessLevelSchema.safeParse("owner").success).toBe(false);
  });

  it("round-trips the access state through JSON", () => {
    expect(accessStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    const locked = { ...state, emailVerifiedAt: null, betaState: "relocked", suspendedAt: 1 };
    expect(accessStateSchema.parse(locked)).toEqual(locked);
  });

  it.each([
    ["an unknown key", { ...state, isAdmin: true }],
    ["a missing field", { ...state, deletionState: undefined }],
    ["an unknown beta state", { ...state, betaState: "open" }],
    ["a negative generation", { ...state, accessGeneration: -1 }],
    ["a fractional epoch", { ...state, accessEpoch: 1.5 }],
    ["an ISO timestamp", { ...state, emailVerifiedAt: "2026-09-15T00:00:00Z" }],
    ["an unsafe integer", { ...state, accessGeneration: 2 ** 60 }],
  ])("rejects %s", (_label, value) => {
    expect(accessStateSchema.safeParse(value).success).toBe(false);
  });
});

describe("analytics consent (§15)", () => {
  it("defines the stored consent values", () => {
    expect(analyticsConsentStates).toEqual(["unset", "granted", "denied"]);
  });

  it("requires a decision time exactly when a choice was made", () => {
    expect(analyticsConsentSchema.parse({ state: "unset", decidedAt: null })).toEqual({
      state: "unset",
      decidedAt: null,
    });
    expect(analyticsConsentSchema.safeParse({ state: "granted", decidedAt: 5 }).success).toBe(true);
    expect(analyticsConsentSchema.safeParse({ state: "denied", decidedAt: null }).success).toBe(
      false,
    );
    expect(analyticsConsentSchema.safeParse({ state: "unset", decidedAt: 5 }).success).toBe(false);
    expect(
      analyticsConsentSchema.safeParse({ state: "granted", decidedAt: 5, source: "banner" })
        .success,
    ).toBe(false);
  });
});
