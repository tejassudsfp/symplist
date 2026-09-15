import { describe, expect, it } from "vitest";
import { effectiveBetaState, evaluateAccess, satisfiesAccess } from "./evaluate.ts";
import type { AccessState } from "./types.ts";

const admitted: AccessState = {
  emailVerifiedAt: 1,
  betaState: "unlocked",
  suspendedAt: null,
  onboardingStep: "done",
  role: "member",
  accessGeneration: 0,
  accessEpoch: 0,
  deletionState: "none",
};

const required = { betaAccessRequired: true };
const open = { betaAccessRequired: false };

describe("access levels (§5.4)", () => {
  it("admits a verified, unlocked, unrestricted member at identity and admitted but not admin", () => {
    expect(evaluateAccess(admitted, "identity", required)).toEqual({ allowed: true });
    expect(evaluateAccess(admitted, "admitted", required)).toEqual({ allowed: true });
    expect(evaluateAccess(admitted, "admin", required)).toEqual({
      allowed: false,
      code: "access.admin_required",
    });
    expect(satisfiesAccess({ ...admitted, role: "admin" }, "admin", required)).toBe(true);
  });

  it("lets locked, relocked, suspended and unverified accounts reach identity-level routes", () => {
    for (const state of [
      { ...admitted, betaState: "locked" as const },
      { ...admitted, betaState: "relocked" as const },
      { ...admitted, suspendedAt: 5 },
      { ...admitted, emailVerifiedAt: null },
    ]) {
      expect(evaluateAccess(state, "identity", required).allowed).toBe(true);
      expect(evaluateAccess(state, "admitted", required).allowed).toBe(false);
    }
  });

  it("returns the first failing rule: unverified, suspended, relocked, locked, role", () => {
    const worst: AccessState = {
      ...admitted,
      emailVerifiedAt: null,
      suspendedAt: 9,
      betaState: "relocked",
    };
    expect(evaluateAccess(worst, "admin", required)).toEqual({
      allowed: false,
      code: "access.unverified",
    });
    expect(evaluateAccess({ ...worst, emailVerifiedAt: 1 }, "admitted", required)).toEqual({
      allowed: false,
      code: "access.suspended",
    });
    expect(
      evaluateAccess({ ...worst, emailVerifiedAt: 1, suspendedAt: null }, "admitted", required),
    ).toEqual({ allowed: false, code: "access.relocked" });
    expect(evaluateAccess({ ...admitted, betaState: "locked" }, "admitted", required)).toEqual({
      allowed: false,
      code: "access.locked",
    });
  });

  it("refuses every level, identity included, while the account is being deleted", () => {
    const deleting: AccessState = { ...admitted, role: "admin", deletionState: "deleting" };
    for (const level of ["identity", "admitted", "admin"] as const) {
      expect(evaluateAccess(deleting, level, required)).toEqual({
        allowed: false,
        code: "auth.session_required",
      });
    }
  });

  it("treats locked accounts as unlocked when beta access is not required, but never relocked ones", () => {
    const locked: AccessState = { ...admitted, betaState: "locked" };
    expect(effectiveBetaState(locked, open)).toBe("unlocked");
    expect(effectiveBetaState(locked, required)).toBe("locked");
    expect(evaluateAccess(locked, "admitted", open)).toEqual({ allowed: true });
    expect(evaluateAccess({ ...admitted, betaState: "relocked" }, "admitted", open)).toEqual({
      allowed: false,
      code: "access.relocked",
    });
    expect(evaluateAccess({ ...locked, suspendedAt: 3 }, "admitted", open).allowed).toBe(false);
    expect(evaluateAccess({ ...locked, emailVerifiedAt: null }, "admitted", open).allowed).toBe(
      false,
    );
  });
});
