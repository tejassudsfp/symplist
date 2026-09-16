import { All, Controller, Get, Module, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Access } from "../../src/common/access.decorator.ts";
import { RouteClass } from "../../src/common/route-classes.ts";

/** What a handler of each route class can see of the request's credentials. */
function seen(req: Request) {
  return {
    cookies: Object.keys(req.cookies ?? {}).sort(),
    rawCookieHeader: req.headers.cookie ?? null,
    authorization: req.headers.authorization ?? null,
    rawHeaderNames: req.rawHeaders
      .filter((_, index) => index % 2 === 0)
      .map((name) => name.toLowerCase())
      .filter((name) => name === "cookie" || name === "authorization")
      .sort(),
  };
}

/** One probe route per route class (§5.3). */
@Controller()
export class RouteClassProbeController {
  @Post("probe/app")
  @RouteClass("app")
  @Access("identity")
  appWrite(@Req() req: Request) {
    return seen(req);
  }

  @Get("probe/app")
  @RouteClass("app")
  @Access("identity")
  appRead(@Req() req: Request) {
    return seen(req);
  }

  @Post("auth/probe")
  @RouteClass("pre_session")
  preSession(@Req() req: Request) {
    return seen(req);
  }

  @Get("connections/callback/guard-probe")
  @RouteClass("connection_callback")
  @Access("identity")
  callback(@Req() req: Request) {
    return seen(req);
  }

  @Post("artifact/:id/password")
  @RouteClass("share_form")
  shareForm(@Req() req: Request) {
    return seen(req);
  }

  @Get("artifact/:id")
  @RouteClass("share_read")
  shareRead(@Req() req: Request) {
    return seen(req);
  }

  @Post("oauth/token/guard-probe")
  @RouteClass("oauth_public")
  token(@Req() req: Request) {
    return seen(req);
  }

  @Get("oauth/authorize/guard-probe")
  @RouteClass("oauth_authorize")
  authorize(@Req() req: Request) {
    return seen(req);
  }

  @All("mcp")
  @RouteClass("mcp")
  mcp(@Req() req: Request) {
    return seen(req);
  }

  @Post("internal/v1/probe")
  @RouteClass("signed")
  signed(@Req() req: Request) {
    return seen(req);
  }

  @Get(".well-known/probe")
  @RouteClass("public_read")
  wellKnown(@Req() req: Request) {
    return seen(req);
  }
}

@Module({ controllers: [RouteClassProbeController] })
export class RouteClassProbeModule {}
