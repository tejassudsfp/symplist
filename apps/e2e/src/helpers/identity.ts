import type { BrowserContext, Page } from "@playwright/test";
import { type MeResponse, meResponseSchema } from "@symplist/contracts";

/*
 * The identity a spec needs before the app shell will render at all.
 *
 * Every route in the `(app)` group sits behind two checks the access feature added: the web proxy
 * sends a visitor with no session-hint cookie to the email entry (§5.1), and `SessionGate` replaces
 * the shell with sign-in whenever `GET /v1/me` says the caller is signed out (§5.4). Both are
 * correct, and `access.spec.ts` drives them end to end against a real api.
 *
 * A spec that is not about access — the shell's landmarks, themes and focus order, or search against
 * contract-shaped fixtures — still has to get past them. It does so here, with the hint cookie and
 * one admitted identity, and leaves every other read to fail or to its own fixtures.
 */

/**
 * The web proxy's non-secret presence cookie (`SESSION_HINT_COOKIE` in `apps/web/src/proxy.ts`). It
 * carries no session: it says only that someone signed in on this device, and the api stays the one
 * authority over what a visitor may see.
 */
export const SESSION_HINT_COOKIE = "sym_hint";

/** Puts the proxy's session hint in a browser context. */
export async function grantSessionHint(context: BrowserContext, webOrigin: string): Promise<void> {
  await context.addCookies([
    { name: SESSION_HINT_COOKIE, value: "1", url: webOrigin, sameSite: "Lax" },
  ]);
}

/**
 * An admitted account's `GET /v1/me` body — Maya from the sample dataset, matching the fixture the
 * web app's own tests use. It is parsed against the contract, so a spec that stubs the identity
 * fails the moment `meResponseSchema` moves under it.
 */
export function admittedIdentity(overrides: Partial<MeResponse> = {}): MeResponse {
  return meResponseSchema.parse({
    user: {
      id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a",
      email: "maya@example.com",
      displayName: "Maya Rao",
      role: "member",
      ...(overrides.user ?? {}),
    },
    access: {
      emailVerifiedAt: Date.UTC(2026, 8, 1, 9),
      betaState: "unlocked",
      suspendedAt: null,
      onboardingStep: "done",
      role: "member",
      accessGeneration: 2,
      accessEpoch: 0,
      deletionState: "none",
      ...(overrides.access ?? {}),
    },
    destination: overrides.destination ?? "app",
    betaAccessRequired: overrides.betaAccessRequired ?? true,
  });
}

/**
 * Grants the hint cookie and answers `GET /v1/me` with an admitted identity, leaving every other
 * request alone. Register it after any catch-all route the spec installs: Playwright matches the
 * most recently registered handler first.
 */
export async function stubAdmittedIdentity(page: Page, webOrigin: string): Promise<void> {
  await grantSessionHint(page.context(), webOrigin);
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "access-control-allow-origin": route.request().headers().origin ?? "*",
        "access-control-allow-credentials": "true",
      },
      body: JSON.stringify(admittedIdentity()),
    }),
  );
}
