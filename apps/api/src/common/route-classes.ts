import { SetMetadata } from "@nestjs/common";

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

/** Which cookies a class may read; the route-class guard removes every other cookie (§5.2, §5.3). */
export type CookieAccess = "session" | "session_and_vault" | "share_session" | "none";

/** The host a class is served on (§6, §13.2). */
export type RouteSurface = "api" | "share";

/** The `Origin` rule a class enforces before any D1 access (§5.3). */
export type OriginRule =
  /** Unsafe methods need `Origin` equal to `WEB_ORIGIN`. */
  | "web_for_unsafe_methods"
  /** Every method needs `Origin` equal to `WEB_ORIGIN`. */
  | "web"
  /** `Origin` equal to `ARTIFACT_ORIGIN`, or absent with `Sec-Fetch-Site: same-origin`. */
  | "artifact_or_same_origin"
  /** A present `Origin` must be allowlisted; an absent one is fine. */
  | "allowlisted_if_present"
  | "none";

export interface RouteClassRule {
  readonly surface: RouteSurface;
  readonly cookies: CookieAccess;
  readonly origin: OriginRule;
  /** `session`: the session-bound token on unsafe methods; `pre_session`: the literal `1`. */
  readonly csrfHeader: "session" | "pre_session" | "none";
  /** Whether `Authorization` reaches the handler; every other class drops it (§5.2). */
  readonly bearer: boolean;
  /** Whether `@Access` may be declared: only classes that read the session cookie. */
  readonly sessionAccess: "required" | "optional" | "forbidden";
  /** HTTP methods the class may be declared on. */
  readonly methods: readonly RequestMethodName[];
  /** Path prefixes the class may be mounted under (after the global prefix is applied). */
  readonly pathPrefixes: readonly string[];
}

export type RequestMethodName = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL";

const unsafe: readonly RequestMethodName[] = ["POST", "PUT", "PATCH", "DELETE"];
const all: readonly RequestMethodName[] = ["GET", "HEAD", ...unsafe];

/** The rule table behind §5.3, enforced by the route-class guard and the coverage test. */
export const routeClassRules: Readonly<Record<RouteClass, RouteClassRule>> = Object.freeze({
  app: {
    surface: "api",
    cookies: "session_and_vault",
    origin: "web_for_unsafe_methods",
    csrfHeader: "session",
    bearer: false,
    sessionAccess: "required",
    methods: all,
    pathPrefixes: ["/v1/"],
  },
  pre_session: {
    surface: "api",
    cookies: "none",
    origin: "web",
    csrfHeader: "pre_session",
    bearer: false,
    sessionAccess: "forbidden",
    methods: unsafe,
    pathPrefixes: ["/v1/auth/"],
  },
  connection_callback: {
    surface: "api",
    cookies: "session",
    origin: "none",
    csrfHeader: "none",
    bearer: false,
    sessionAccess: "required",
    methods: ["GET"],
    pathPrefixes: ["/v1/connections/callback"],
  },
  share_form: {
    surface: "share",
    cookies: "share_session",
    origin: "artifact_or_same_origin",
    csrfHeader: "none",
    bearer: false,
    sessionAccess: "forbidden",
    methods: ["POST"],
    pathPrefixes: ["/artifact/"],
  },
  share_read: {
    surface: "share",
    cookies: "share_session",
    origin: "none",
    csrfHeader: "none",
    bearer: false,
    sessionAccess: "forbidden",
    methods: ["GET", "HEAD"],
    pathPrefixes: ["/artifact/"],
  },
  oauth_public: {
    surface: "api",
    cookies: "none",
    origin: "none",
    csrfHeader: "none",
    bearer: false,
    sessionAccess: "forbidden",
    methods: ["POST"],
    pathPrefixes: ["/oauth/"],
  },
  oauth_authorize: {
    surface: "api",
    cookies: "session",
    origin: "none",
    csrfHeader: "none",
    bearer: false,
    sessionAccess: "optional",
    methods: ["GET"],
    pathPrefixes: ["/oauth/authorize"],
  },
  mcp: {
    surface: "api",
    cookies: "none",
    origin: "allowlisted_if_present",
    csrfHeader: "none",
    bearer: true,
    sessionAccess: "forbidden",
    methods: ["GET", "POST", "DELETE", "ALL"],
    pathPrefixes: ["/mcp"],
  },
  signed: {
    surface: "api",
    cookies: "none",
    origin: "none",
    csrfHeader: "none",
    bearer: false,
    sessionAccess: "forbidden",
    methods: ["POST"],
    pathPrefixes: ["/webhooks/", "/internal/v1/"],
  },
  public_read: {
    surface: "api",
    cookies: "none",
    origin: "none",
    csrfHeader: "none",
    bearer: false,
    sessionAccess: "forbidden",
    methods: ["GET", "HEAD"],
    pathPrefixes: ["/healthz", "/.well-known/"],
  },
} satisfies Record<RouteClass, RouteClassRule>);

/** Metadata key of {@link RouteClass}. */
export const ROUTE_CLASS_METADATA = "symplist:route-class";

/**
 * Declares the CSRF and credential class of a route or of every route of a controller (§5.3). A
 * handler-level class overrides the controller's.
 */
export const RouteClass = (routeClass: RouteClass): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_CLASS_METADATA, routeClass);

/** Whether a string names a route class. */
export function isRouteClass(value: unknown): value is RouteClass {
  return typeof value === "string" && (routeClasses as readonly string[]).includes(value);
}
