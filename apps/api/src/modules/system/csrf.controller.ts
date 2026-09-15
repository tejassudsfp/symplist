import { Controller, Get } from "@nestjs/common";
import type { SessionContext } from "@symplist/core/access";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { SessionService } from "../../common/auth/session.service.ts";
import { RouteClass } from "../../common/route-classes.ts";

export interface CsrfTokenResponse {
  /** `HMAC(SESSION_DIGEST_SECRET, 'csrf' || sessionId)`; send it as `X-Symplist-CSRF` (§5.3). */
  readonly token: string;
}

/** Issues the session-bound CSRF token for the `app` route class (§5.3). */
@Controller("auth")
export class CsrfController {
  constructor(private readonly sessions: SessionService) {}

  @Get("csrf")
  @RouteClass("app")
  @Access("identity")
  csrf(@CurrentSession() session: SessionContext): CsrfTokenResponse {
    return { token: this.sessions.csrfToken(session.sessionId) };
  }
}
