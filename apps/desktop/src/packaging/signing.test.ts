// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decideSigning, notarizationVariables } from "./signing.ts";

/** A fully configured signing machine. */
const configured = {
  APPLE_ID: "releases@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
  APPLE_TEAM_ID: "ABCDE12345",
  CSC_NAME: "Developer ID Application: Example (ABCDE12345)",
};

describe("deciding whether a packaging run signs", () => {
  it("signs when the notary credentials and an identity are all present", () => {
    const decision = decideSigning(configured);
    expect(decision.signed).toBe(true);
    expect(decision.args).toEqual([]);
    expect(decision.missing).toEqual([]);
  });

  it("accepts a .p12 in place of a keychain identity", () => {
    const { CSC_NAME: _name, ...rest } = configured;
    expect(decideSigning({ ...rest, CSC_LINK: "base64-or-path" }).signed).toBe(true);
  });

  it("falls back to unsigned on a machine with no credentials, and says so", () => {
    const decision = decideSigning({});
    expect(decision.signed).toBe(false);
    expect(decision.reason).toContain("unsigned");
    // The overrides have to switch off every part of the signed config, or electron-builder tries to
    // harden and notarize a build it cannot sign and fails late instead of producing the dev artefact.
    expect(decision.args).toContain("-c.mac.identity=null");
    expect(decision.args).toContain("-c.mac.notarize=false");
    expect(decision.args).toContain("-c.mac.hardenedRuntime=false");
    expect(decision.args).toContain("-c.mac.entitlements=null");
    expect(decision.args).toContain("-c.mac.entitlementsInherit=null");
  });

  it("refuses to sign on a half-configured machine, and names what is missing", () => {
    // The dangerous case: enough set to look configured, so a run that quietly produced an unsigned
    // artefact with a release's name would be the thing nobody checked.
    for (const absent of notarizationVariables) {
      const partial = { ...configured, [absent]: "" };
      const decision = decideSigning(partial);
      expect(decision.signed).toBe(false);
      expect(decision.missing).toContain(absent);
      expect(decision.reason).toContain(absent);
    }
  });

  it("treats an identity with no notary credentials as not configured", () => {
    const decision = decideSigning({ CSC_NAME: configured.CSC_NAME });
    expect(decision.signed).toBe(false);
    expect(decision.missing).toEqual(notarizationVariables);
  });

  it("treats whitespace as absent, which is what an unset shell variable expands to", () => {
    expect(decideSigning({ ...configured, APPLE_TEAM_ID: "   " }).signed).toBe(false);
  });

  it("names the identity variables together, since either one satisfies the requirement", () => {
    expect(decideSigning({}).missing).toContain("CSC_NAME or CSC_LINK");
  });

  it("never puts a credential in the reason it prints to the build log", () => {
    const decision = decideSigning({ ...configured, APPLE_TEAM_ID: "" });
    for (const secret of [configured.APPLE_APP_SPECIFIC_PASSWORD, configured.CSC_NAME]) {
      expect(decision.reason).not.toContain(secret);
    }
  });
});
