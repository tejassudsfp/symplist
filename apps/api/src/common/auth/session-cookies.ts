import { isIP } from "node:net";
import type { ApiConfig } from "@symplist/config/api";
import type { CookieOptions, Response } from "express";

/** Production session cookie: host-only, so it never reaches the web or share hosts (§5.1). */
export const PRODUCTION_SESSION_COOKIE = "__Host-sym_session";
/** Development and test session cookie, without the prefix that requires HTTPS (§5.1). */
export const DEVELOPMENT_SESSION_COOKIE = "sym_session";
/** Production Vault session cookie (§11.1). */
export const PRODUCTION_VAULT_COOKIE = "__Host-sym_vault";
export const DEVELOPMENT_VAULT_COOKIE = "sym_vault";
/** Share session cookies are `__Host-sym_share_<grantId>` in production (§13.3). */
export const PRODUCTION_SHARE_COOKIE_PREFIX = "__Host-sym_share_";
export const DEVELOPMENT_SHARE_COOKIE_PREFIX = "sym_share_";
/** The non-secret presence cookie the Next.js proxy reads to redirect signed-out visitors (§5.1). */
export const HINT_COOKIE = "sym_hint";

type CookieConfig = Pick<ApiConfig, "NODE_ENV" | "WEB_ORIGIN" | "API_ORIGIN">;

/** The cookie names for the runtime. */
export function cookieNames(config: Pick<ApiConfig, "NODE_ENV">) {
  const production = config.NODE_ENV === "production";
  return Object.freeze({
    session: production ? PRODUCTION_SESSION_COOKIE : DEVELOPMENT_SESSION_COOKIE,
    vault: production ? PRODUCTION_VAULT_COOKIE : DEVELOPMENT_VAULT_COOKIE,
    sharePrefix: production ? PRODUCTION_SHARE_COOKIE_PREFIX : DEVELOPMENT_SHARE_COOKIE_PREFIX,
    hint: HINT_COOKIE,
  });
}

/**
 * The parent domain the `sym_hint` cookie is scoped to: the longest domain suffix of at least two
 * labels shared by the web and api hosts. Returns undefined (a host-only cookie) for IP addresses,
 * `localhost` and hosts that share no such suffix, where a Domain attribute would be rejected or
 * unnecessary.
 */
export function hintCookieDomain(
  config: Pick<ApiConfig, "WEB_ORIGIN" | "API_ORIGIN">,
): string | undefined {
  const web = new URL(config.WEB_ORIGIN).hostname;
  const api = new URL(config.API_ORIGIN).hostname;
  if (isIP(web) !== 0 || isIP(api) !== 0 || web.startsWith("[") || api.startsWith("["))
    return undefined;
  if (web === api) return undefined;
  const webLabels = web.split(".").reverse();
  const apiLabels = api.split(".").reverse();
  const shared: string[] = [];
  for (let index = 0; index < Math.min(webLabels.length, apiLabels.length); index += 1) {
    if (webLabels[index] !== apiLabels[index]) break;
    shared.push(webLabels[index] ?? "");
  }
  return shared.length >= 2 ? shared.reverse().join(".") : undefined;
}

/**
 * Attributes of the session cookie (§5.1): HttpOnly, SameSite=Lax, Path=/, no Domain, Secure in
 * production, expiring with the session.
 */
export function sessionCookieOptions(config: CookieConfig, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.NODE_ENV === "production",
    maxAge: Math.max(0, maxAgeMs),
  };
}

/** Attributes of `sym_hint=1`: scoped to the parent domain when there is one, never secret. */
export function hintCookieOptions(config: CookieConfig, maxAgeMs: number): CookieOptions {
  const domain = hintCookieDomain(config);
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.NODE_ENV === "production",
    maxAge: Math.max(0, maxAgeMs),
    ...(domain ? { domain } : {}),
  };
}

/** Sets the session and hint cookies for a new session. */
export function setSessionCookies(
  res: Response,
  config: CookieConfig,
  session: { readonly token: string; readonly expiresAt: number },
  now: number,
): void {
  const names = cookieNames(config);
  const maxAge = session.expiresAt - now;
  res.cookie(names.session, session.token, sessionCookieOptions(config, maxAge));
  res.cookie(names.hint, "1", hintCookieOptions(config, maxAge));
}

/** Clears the session, Vault and hint cookies (logout, revocation, account deletion; §5.1). */
export function clearSessionCookies(res: Response, config: CookieConfig): void {
  const names = cookieNames(config);
  const { maxAge: _session, ...session } = sessionCookieOptions(config, 0);
  const { maxAge: _hint, ...hint } = hintCookieOptions(config, 0);
  res.clearCookie(names.session, session);
  res.clearCookie(names.vault, { ...session, sameSite: "strict" });
  res.clearCookie(names.hint, hint);
}
