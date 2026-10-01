/**
 * Whether a packaging run signs and notarizes, decided from the environment alone.
 *
 * `electron-builder.yml` carries the *signed* configuration, because that is what a released build is.
 * A machine without the Developer ID credentials cannot produce one, and the useful thing for it to do
 * is produce the unsigned build rather than fail — so the decision is made here and applied as CLI
 * overrides, and the script says out loud which of the two it made. Silently shipping an unsigned
 * artefact named like a released one is the failure mode this exists to prevent.
 *
 * Nothing here reads a secret. It checks that the three variables are present and non-empty; their
 * values go to electron-builder through the environment and are never logged.
 */

/** The variables Apple's notary service needs, all three or none. */
export const notarizationVariables = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

export interface SigningDecision {
  /** Whether this run signs with a Developer ID and sends the result to Apple. */
  readonly signed: boolean;
  /** Extra electron-builder arguments; empty when signing. */
  readonly args: readonly string[];
  /** Why, in one line, for the build log. */
  readonly reason: string;
  /** Variables that were expected and missing, for naming them rather than saying "some". */
  readonly missing: readonly string[];
}

function present(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  return (env[name] ?? "").trim().length > 0;
}

/**
 * Reads the environment and returns what to do.
 *
 * Signing needs all three notarization variables **and** an identity: `CSC_NAME` names a certificate in
 * the keychain, `CSC_LINK` supplies one as a .p12. Without an identity there is nothing to sign with,
 * and without the notary credentials Apple would reject the result at the gate anyway, so a partial set
 * is treated as "not configured" and named — a half-configured machine is the case most likely to ship
 * something nobody checked.
 */
export function decideSigning(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SigningDecision {
  const hasIdentity = present(env, "CSC_NAME") || present(env, "CSC_LINK");
  const missingNotary = notarizationVariables.filter((name) => !present(env, name));
  const missing = [...missingNotary, ...(hasIdentity ? [] : ["CSC_NAME or CSC_LINK"])];

  if (missing.length === 0) {
    return {
      signed: true,
      args: [],
      reason: "signing with the configured Developer ID and notarizing with Apple",
      missing: [],
    };
  }

  return {
    signed: false,
    args: [
      "-c.mac.identity=null",
      "-c.mac.notarize=false",
      "-c.mac.hardenedRuntime=false",
      "-c.mac.entitlements=null",
      "-c.mac.entitlementsInherit=null",
    ],
    reason: `building unsigned: ${missing.join(", ")} not set`,
    missing,
  };
}
