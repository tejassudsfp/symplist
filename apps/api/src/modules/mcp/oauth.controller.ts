import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import {
  type ConnectionParams,
  connectionParamsSchema,
  type OAuthDecision,
  oauthAuthorizeSchema,
  oauthDecisionSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import type { Request, Response } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { SessionService } from "../../common/auth/session.service.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { foldedIdempotencyOf } from "../../common/idempotency/idempotency.interceptor.ts";
import { OneTimeSecret } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { IpLimit } from "../../infra/limits/ip-limits.ts";
import { mcpAnswer } from "./mcp-grants.controller.ts";
import { OAUTH_RUNTIME, OAuthBoundaryError, type OAuthRuntime } from "./oauth.runtime.ts";

function noStore(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
}
function failure(error: unknown, response: Response) {
  if (!(error instanceof OAuthBoundaryError)) throw error;
  response.status(400).json({ error: error.code });
}

@Controller("oauth")
export class OAuthController {
  constructor(
    @Inject(OAUTH_RUNTIME) private readonly runtime: OAuthRuntime,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly sessions: SessionService,
  ) {}

  @Post("register")
  @RouteClass("oauth_public")
  @IpLimit("oauth_register")
  async register(@Body() body: unknown, @Res() response: Response) {
    noStore(response);
    try {
      response.status(201).json(await this.runtime.register(body));
    } catch (error) {
      failure(error, response);
    }
  }

  @Get("authorize")
  @RouteClass("oauth_authorize")
  @IpLimit("oauth_authorize")
  async authorize(@Req() request: Request, @Res() response: Response) {
    noStore(response);
    try {
      const parsed = oauthAuthorizeSchema.safeParse(request.query);
      if (!parsed.success) throw new OAuthBoundaryError("invalid_request");
      const input = parsed.data;
      const client = await this.runtime.client(input.client_id, input.redirect_uri);
      this.runtime.validateTarget(input.resource, input.scope);
      const resolved = await this.sessions.resolve(request, { fresh: true });
      if (!resolved) {
        const next = `/oauth/authorize?${new URLSearchParams(input).toString()}`;
        response.redirect(303, `${this.config.WEB_ORIGIN}/signin?${new URLSearchParams({ next })}`);
        return;
      }
      const access = this.sessions.evaluate(resolved, "admitted");
      if (!access.allowed) throw new ApiError(access.code);
      const session = this.sessions.contextOf(resolved);
      const id = await mcpAnswer(() =>
        this.runtime.requests.create(
          { ownerId: session.userId, sessionId: session.sessionId },
          input,
          client,
        ),
      );
      response.redirect(
        303,
        `${this.config.WEB_ORIGIN}/oauth/consent?request=${encodeURIComponent(id)}`,
      );
    } catch (error) {
      failure(error, response);
    }
  }

  @Post("token")
  @RouteClass("oauth_public")
  async token(@Body() body: unknown, @Res() response: Response) {
    noStore(response);
    try {
      response.status(200).json(await this.runtime.exchange(body));
    } catch (error) {
      failure(error, response);
    }
  }

  @Post("revoke")
  @RouteClass("oauth_public")
  async revoke(@Body() body: unknown, @Res() response: Response) {
    noStore(response);
    try {
      if (
        !body ||
        typeof body !== "object" ||
        !("token" in body) ||
        !("client_id" in body) ||
        typeof body.token !== "string" ||
        typeof body.client_id !== "string" ||
        body.token.length > 16384 ||
        body.client_id.length > 2048
      )
        throw new OAuthBoundaryError("invalid_request");
      await this.runtime.revoke(body.token, body.client_id);
      response.status(200).send();
    } catch (error) {
      failure(error, response);
    }
  }
}

/** Explicit app prefix: the public OAuth tree is excluded from the global prefix. */
@Controller("v1/oauth/requests")
@RouteClass("app")
@Access("admitted", { fresh: true })
export class OAuthConsentController {
  constructor(@Inject(OAUTH_RUNTIME) private readonly runtime: OAuthRuntime) {}
  @Get(":id")
  view(
    @CurrentSession() session: SessionContext,
    @Param({ schema: connectionParamsSchema }) params: ConnectionParams,
  ) {
    return mcpAnswer(() =>
      this.runtime.requests.view(
        { ownerId: session.userId, sessionId: session.sessionId },
        params.id,
      ),
    );
  }
  @Post(":id/decision")
  @HttpCode(200)
  @OneTimeSecret(["redirectUrl"], { folded: true })
  decide(
    @CurrentSession() session: SessionContext,
    @Param({ schema: connectionParamsSchema }) params: ConnectionParams,
    @Body({ schema: oauthDecisionSchema }) body: OAuthDecision,
    @Req() request: Request,
  ) {
    return mcpAnswer(() =>
      this.runtime.requests.decide(
        { ownerId: session.userId, sessionId: session.sessionId },
        params.id,
        body,
        foldedIdempotencyOf(request),
      ),
    );
  }
}
