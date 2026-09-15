import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { csrfHeader, preSessionCsrfHeaderValue } from "@symplist/contracts";
import type { Request } from "express";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { cookieNames } from "../auth/session-cookies.ts";
import { ApiError } from "../errors/api-error.ts";
import { isShareHost } from "../http/host-surface.ts";
import { AppLogger } from "../logging/logger.ts";
import { matchedRoute, requestStateOf } from "../request-context.ts";
import {
  type CookieAccess,
  isRouteClass,
  ROUTE_CLASS_METADATA,
  type RouteClass,
  routeClassRules,
} from "../route-classes.ts";

const unsafeMethods: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Whether a request method changes state. */
export function isUnsafeMethod(method: string): boolean {
  return unsafeMethods.has(method.toUpperCase());
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Keeps only the cookies a class may read and drops the raw header, so nothing re-parses it. */
function scopeCookies(req: Request, access: CookieAccess, config: ApiConfig): void {
  const names = cookieNames(config);
  const parsed = (req.cookies ?? {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const allowed =
      (access === "session" && name === names.session) ||
      (access === "session_and_vault" && (name === names.session || name === names.vault)) ||
      (access === "share_session" && name.startsWith(names.sharePrefix));
    if (allowed) kept[name] = value;
  }
  req.cookies = kept;
  req.signedCookies = {};
  delete req.headers.cookie;
}

/**
 * Enforces the route's CSRF and credential class before any D1 access (§5.2, §5.3): the class must be
 * declared; share classes are served only on the share host and every other class only on the api
 * host; cookies outside the class are removed; `Authorization` is removed except on `/mcp`; and the
 * class's `Origin` and pre-session header rules apply. The session-bound CSRF token of the `app`
 * class is checked by the access guard once the session is known.
 */
@Injectable()
export class RouteClassGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly logger: AppLogger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;
    const req = context.switchToHttp().getRequest<Request>();
    const declared = this.reflector.getAllAndOverride<unknown>(ROUTE_CLASS_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    const state = requestStateOf(req);
    if (state) state.route = matchedRoute(req);
    if (!isRouteClass(declared)) {
      this.logger.error("route_class.missing");
      throw ApiError.internal();
    }
    if (state) state.routeClass = declared;
    const rule = routeClassRules[declared];

    const onShareHost = isShareHost(req, this.config);
    if ((rule.surface === "share") !== onShareHost) throw ApiError.notFound();

    scopeCookies(req, rule.cookies, this.config);
    if (!rule.bearer) delete req.headers.authorization;

    this.checkOrigin(declared, req);
    if (
      rule.csrfHeader === "pre_session" &&
      header(req, csrfHeader) !== preSessionCsrfHeaderValue
    ) {
      throw new ApiError("auth.csrf_invalid");
    }
    return true;
  }

  private checkOrigin(routeClass: RouteClass, req: Request): void {
    const origin = header(req, "origin");
    switch (routeClassRules[routeClass].origin) {
      case "web_for_unsafe_methods":
        if (isUnsafeMethod(req.method) && origin !== this.config.WEB_ORIGIN) {
          throw new ApiError("auth.origin_forbidden");
        }
        return;
      case "web":
        if (origin !== this.config.WEB_ORIGIN) throw new ApiError("auth.origin_forbidden");
        return;
      case "artifact_or_same_origin":
        if (origin === undefined) {
          if (header(req, "sec-fetch-site") !== "same-origin") {
            throw new ApiError("auth.origin_forbidden");
          }
        } else if (origin !== this.config.ARTIFACT_ORIGIN) {
          throw new ApiError("auth.origin_forbidden");
        }
        return;
      case "allowlisted_if_present":
        if (
          origin !== undefined &&
          origin !== this.config.WEB_ORIGIN &&
          origin !== this.config.API_ORIGIN
        ) {
          throw new ApiError("auth.origin_forbidden");
        }
        return;
      case "none":
        return;
    }
  }
}
