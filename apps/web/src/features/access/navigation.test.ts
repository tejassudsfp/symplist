import { describe, expect, it } from "vitest";
import {
  afterSignInPath,
  destinationPath,
  needsDocumentNavigation,
  safeNextPath,
  signInPathFor,
} from "./navigation.ts";
import { admittedAccess, lockedAccess, mayaMe, pausedAccess } from "./test-support.tsx";

describe("where an account belongs (§5.4)", () => {
  it("maps every destination to its screen", () => {
    expect(destinationPath(mayaMe())).toBe("/now");
    expect(destinationPath(mayaMe({ access: lockedAccess }))).toBe("/access");
    expect(destinationPath(mayaMe({ access: pausedAccess }))).toBe("/access/paused");
    expect(destinationPath(mayaMe({ access: { ...admittedAccess, onboardingStep: "name" } }))).toBe(
      "/welcome",
    );
    expect(
      destinationPath(mayaMe({ access: { ...admittedAccess, onboardingStep: "connections" } })),
    ).toBe("/welcome/connections");
  });
});

describe("the return path through sign-in (§14.5)", () => {
  it("accepts only same-origin paths", () => {
    expect(safeNextPath("/settings/account")).toBe("/settings/account");
    expect(safeNextPath("/now/01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a?view=chat")).toBe(
      "/now/01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a?view=chat",
    );
    for (const hostile of [
      "https://evil.test/now",
      "//evil.test/now",
      "/\\evil.test",
      "javascript:alert(1)",
      "now",
      "",
      null,
      undefined,
    ]) {
      expect(safeNextPath(hostile)).toBeNull();
    }
  });

  it("never returns to sign-in itself", () => {
    expect(safeNextPath("/signin")).toBeNull();
    expect(safeNextPath("/signin/verify")).toBeNull();
  });

  it("builds the sign-in address with the return path and the expiry notice", () => {
    expect(signInPathFor("/settings/account")).toBe("/signin?next=%2Fsettings%2Faccount");
    expect(signInPathFor("/now")).toBe("/signin");
    expect(signInPathFor("/now", { expired: true })).toBe("/signin?expired=1");
  });

  it("sends an account to its destination first, and only then back where it came from", () => {
    expect(afterSignInPath(mayaMe(), "/settings/account")).toBe("/settings/account");
    expect(afterSignInPath(mayaMe({ access: lockedAccess }), "/settings/account")).toBe("/access");
    // An admitted account never returns into the gate or onboarding it left.
    expect(afterSignInPath(mayaMe(), "/access")).toBe("/now");
    expect(afterSignInPath(mayaMe(), "/welcome/connections")).toBe("/now");
    expect(afterSignInPath(mayaMe(), "https://evil.test")).toBe("/now");
  });
});

describe("crossing into an analytics-excluded route group (§15)", () => {
  it("needs a full document navigation from the app", () => {
    expect(needsDocumentNavigation("/now", "/signin")).toBe(true);
    expect(needsDocumentNavigation("/now", "/access/paused")).toBe(true);
    expect(needsDocumentNavigation("/settings/account", "/vault")).toBe(true);
  });

  it("stays a client navigation between excluded screens and back into the app", () => {
    expect(needsDocumentNavigation("/signin/verify", "/access")).toBe(false);
    expect(needsDocumentNavigation("/access", "/now")).toBe(false);
    expect(needsDocumentNavigation("/welcome", "/now")).toBe(false);
  });
});
