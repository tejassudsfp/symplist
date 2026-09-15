import type { RouteClassRegistry } from "../../common/route-classes.ts";

/**
 * The internal endpoints' CSRF and credential class (§5.3): `signed` — no cookies, no CORS, a valid
 * `X-Sym-Signature` required. Merged into the api route-class registry by the route-class coverage.
 */
export const internalRouteClasses = {
  "POST /internal/v1/events": "signed",
  "POST /internal/v1/runs/:runId/output": "signed",
} as const satisfies RouteClassRegistry;
