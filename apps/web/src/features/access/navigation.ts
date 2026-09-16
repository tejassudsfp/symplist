import { isExcludedAnalyticsPath } from "@symplist/analytics";
import type { MeResponse } from "@symplist/contracts";

/** Where a signed-out visitor starts (email entry). */
export const SIGN_IN_PATH = "/signin";
export const CREATE_ACCOUNT_PATH = "/signin/create";
export const VERIFY_PATH = "/signin/verify";
export const BETA_GATE_PATH = "/access";
export const PAUSED_PATH = "/access/paused";
/** Identity-level account management for accounts outside the app (locked, paused, onboarding). */
export const RESTRICTED_ACCOUNT_PATH = "/access/account";
export const ONBOARDING_NAME_PATH = "/welcome";
export const ONBOARDING_CONNECTIONS_PATH = "/welcome/connections";
/** The application opens in the task workspace (overall.md). */
export const APP_HOME_PATH = "/now";

/** The query parameter carrying a same-origin return path through sign-in (§14.5). */
export const NEXT_PARAM = "next";

/** The screen for an account's access state (decision AC1 `destination`, §5.4). */
export function destinationPath(me: Pick<MeResponse, "destination" | "access">): string {
  switch (me.destination) {
    case "app":
      return APP_HOME_PATH;
    case "onboarding":
      return me.access.onboardingStep === "connections"
        ? ONBOARDING_CONNECTIONS_PATH
        : ONBOARDING_NAME_PATH;
    case "beta_gate":
      return BETA_GATE_PATH;
    case "paused":
      return PAUSED_PATH;
  }
}

const authPaths = new Set([SIGN_IN_PATH, CREATE_ACCOUNT_PATH, VERIFY_PATH]);

/**
 * A return path that stays on this origin: an absolute path without a scheme, host, backslash or
 * control character, never back into sign-in. Anything else yields null (§14.5 "accepts only
 * same-origin relative paths").
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (/[\\\p{Cc}]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, "https://symplist.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://symplist.invalid") return null;
  if (authPaths.has(url.pathname) || url.pathname.startsWith(`${SIGN_IN_PATH}/`)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in address that returns to `path` afterwards (when it is a safe app path). */
export function signInPathFor(path: string | null | undefined, options?: { expired?: boolean }) {
  const params = new URLSearchParams();
  const next = safeNextPath(path);
  if (next && next !== APP_HOME_PATH && next !== "/") params.set(NEXT_PARAM, next);
  if (options?.expired) params.set("expired", "1");
  const query = params.toString();
  return query ? `${SIGN_IN_PATH}?${query}` : SIGN_IN_PATH;
}

/**
 * Where a successful sign-in goes: the account's destination, or for an admitted account the safe
 * return path it came from.
 */
export function afterSignInPath(
  me: Pick<MeResponse, "destination" | "access">,
  next: string | null | undefined,
): string {
  if (me.destination !== "app") return destinationPath(me);
  const safe = safeNextPath(next);
  if (!safe) return APP_HOME_PATH;
  const pathname = safe.split(/[?#]/, 1)[0] ?? safe;
  // Never return an admitted account into the gate or onboarding it has left.
  if (pathname === BETA_GATE_PATH || pathname.startsWith(`${BETA_GATE_PATH}/`)) {
    return APP_HOME_PATH;
  }
  if (pathname === ONBOARDING_NAME_PATH || pathname.startsWith(`${ONBOARDING_NAME_PATH}/`)) {
    return APP_HOME_PATH;
  }
  return safe;
}

/** The pathname of the current document, or an empty string outside a browser. */
export function currentPathname(): string {
  return typeof window === "undefined" ? "" : window.location.pathname;
}

/**
 * Whether moving from `from` to `to` must be a full document navigation: entering an analytics-excluded
 * route group (sign-in, the access gate, the Vault) from anywhere else never keeps the app's in-memory
 * state or an analytics client alive (§15).
 */
export function needsDocumentNavigation(from: string, to: string): boolean {
  return isExcludedAnalyticsPath(to) && !isExcludedAnalyticsPath(from);
}

export interface Navigator {
  replace(href: string): void;
  push(href: string): void;
}

/** Navigates within the app, switching to a document navigation when entering an excluded group. */
export function navigateAcrossGroups(
  router: Navigator,
  href: string,
  options: { readonly replace?: boolean; readonly from?: string } = {},
): void {
  const from = options.from ?? currentPathname();
  if (needsDocumentNavigation(from, href)) {
    if (options.replace) window.location.replace(href);
    else window.location.assign(href);
    return;
  }
  if (options.replace) router.replace(href);
  else router.push(href);
}
