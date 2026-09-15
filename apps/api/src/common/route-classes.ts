/**
 * CSRF and credential classes (§5.3). Every controller route declares exactly one:
 *
 * - `app`: cookie-authenticated `/v1/*` unsafe methods; `Origin` must equal `WEB_ORIGIN` and
 *   `X-Symplist-CSRF` must carry the session-bound token.
 * - `pre_session`: lookup, signup and OTP routes; `Origin` must equal `WEB_ORIGIN` and
 *   `X-Symplist-CSRF: 1` forces a preflight.
 * - `connection_callback`: `GET /v1/connections/callback`; needs the single-use attempt nonce, the
 *   same user and the same auth session, and redirects only to a fixed web path.
 * - `share_form`: share-host password posts; `Origin` equals `ARTIFACT_ORIGIN` and a per-render
 *   form nonce is required; the app session cookie is never read.
 * - `share_read`: share-host GET routes; reads only the share session cookie.
 * - `oauth_public`: `/oauth/token`, `/oauth/register`, `/oauth/revoke`; no cookies, no credentialed CORS.
 * - `oauth_authorize`: `GET /oauth/authorize`; reads the session cookie only to create a pending request.
 * - `mcp`: `/mcp`; bearer credentials only, and a present `Origin` must be allowlisted.
 * - `signed`: `/webhooks/*` and `/internal/v1/*`; no cookies, a valid signature is required.
 * - `public_read`: `GET /healthz` and `GET /.well-known/*`; no cookies and no effects.
 *
 * This registry is api-only and never moves into a shared package (§2.3).
 */
export const routeClasses = [
  "app",
  "pre_session",
  "connection_callback",
  "share_form",
  "share_read",
  "oauth_public",
  "oauth_authorize",
  "mcp",
  "signed",
  "public_read",
] as const;

export type RouteClass = (typeof routeClasses)[number];

/** A route key such as `POST /v1/access/redeem`. */
export type RouteKey = `${"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL"} /${string}`;

/** Maps every registered route to its class; the route-class coverage test reads it (§5.3). */
export type RouteClassRegistry = Readonly<Partial<Record<RouteKey, RouteClass>>>;

export const routeClassRegistry: RouteClassRegistry = {};
