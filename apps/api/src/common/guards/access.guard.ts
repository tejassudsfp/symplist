import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { csrfHeader } from "@symplist/contracts";
import type { Request } from "express";
import { ACCESS_METADATA, type AccessRequirement } from "../access.decorator.ts";
import { SessionService } from "../auth/session.service.ts";
import { ApiError } from "../errors/api-error.ts";
import { requestStateOf } from "../request-context.ts";
import { isRouteClass, ROUTE_CLASS_METADATA, routeClassRules } from "../route-classes.ts";
import { isUnsafeMethod } from "./route-class.guard.ts";

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `@Access('identity' | 'admitted' | 'admin')` (§5.2, §5.4): resolves the session cookie (the only
 * credential `/v1` accepts; bearer tokens were already removed), checks the session-bound CSRF token
 * on unsafe `app` requests, and evaluates the access level. Sensitive operations declare
 * `{ fresh: true }` and read D1 instead of the 10-second cache (§3.3). Classes that require a
 * session fail closed when a route forgot `@Access`.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const targets = [context.getHandler(), context.getClass()];
    const routeClass = this.reflector.getAllAndOverride<unknown>(ROUTE_CLASS_METADATA, targets);
    const requirement = this.reflector.getAllAndOverride<AccessRequirement | undefined>(
      ACCESS_METADATA,
      targets,
    );
    if (!isRouteClass(routeClass)) throw ApiError.internal();
    const rule = routeClassRules[routeClass];
    if (!requirement) {
      if (rule.sessionAccess === "required") throw ApiError.internal();
      return true;
    }
    if (rule.sessionAccess === "forbidden") throw ApiError.internal();

    const req = context.switchToHttp().getRequest<Request>();
    const resolved = await this.sessions.resolve(req, { fresh: requirement.fresh });
    if (!resolved) throw new ApiError("auth.session_required");

    if (rule.csrfHeader === "session" && isUnsafeMethod(req.method)) {
      if (!this.sessions.verifyCsrf(resolved.session.id, headerValue(req, csrfHeader))) {
        throw new ApiError("auth.csrf_invalid");
      }
    }

    const decision = this.sessions.evaluate(resolved, requirement.level);
    const state = requestStateOf(req);
    if (state) state.session = this.sessions.contextOf(resolved);
    if (!decision.allowed) throw new ApiError(decision.code);
    return true;
  }
}
