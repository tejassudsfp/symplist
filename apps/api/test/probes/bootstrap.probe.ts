import {
  Body,
  type CanActivate,
  Controller,
  Get,
  Module,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
  UnsupportedMediaTypeException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Access } from "../../src/common/access.decorator.ts";
import { RouteClass } from "../../src/common/route-classes.ts";

/** A feature guard that refuses every request, as Nest's `ForbiddenException` path does. */
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

/** The size of the parsed body, never its content. */
function bodySize(req: RawBodyRequest<Request>) {
  return { rawBytes: req.rawBody?.length ?? null, keys: Object.keys(req.body ?? {}).length };
}

/** Probe routes for the bootstrap tests: prefixes, validation, body limits, raw bodies and errors. */
@Controller()
export class BootstrapProbeController {
  @Get("probe")
  @RouteClass("app")
  @Access("identity")
  probe() {
    return { ok: true };
  }

  @Post("probe/echo")
  @RouteClass("app")
  @Access("admitted")
  echo(
    @Body({ schema: z.strictObject({ title: z.string().min(1).max(10) }) }) body: { title: string },
  ) {
    return { title: body.title };
  }

  @Post("probe/document")
  @RouteClass("app")
  @Access("admitted")
  document(@Req() req: RawBodyRequest<Request>) {
    return bodySize(req);
  }

  @Post("auth/probe-body")
  @RouteClass("pre_session")
  preSessionBody(@Req() req: RawBodyRequest<Request>) {
    return bodySize(req);
  }

  @Post("oauth/token")
  @RouteClass("oauth_public")
  oauthForm(@Req() req: RawBodyRequest<Request>) {
    return bodySize(req);
  }

  @Post("internal/v1/probe-body")
  @RouteClass("signed")
  internalBody(@Req() req: RawBodyRequest<Request>) {
    return bodySize(req);
  }

  @Post("webhooks/probe")
  @RouteClass("signed")
  webhook(@Req() req: RawBodyRequest<Request>) {
    return { rawBytes: req.rawBody?.length ?? null };
  }

  @Get(".well-known/probe")
  @RouteClass("public_read")
  wellKnown() {
    return { ok: true };
  }

  @Get("probe/forbidden")
  @RouteClass("app")
  @Access("identity")
  @UseGuards(DenyGuard)
  forbidden() {
    return { ok: true };
  }

  @Get("probe/unauthorized")
  @RouteClass("app")
  @Access("identity")
  unauthorized() {
    throw new UnauthorizedException("Token for maya@example.test expired");
  }

  @Post("probe/unsupported")
  @RouteClass("app")
  @Access("identity")
  unsupported() {
    throw new UnsupportedMediaTypeException("text/xml is not accepted");
  }
}

@Module({ controllers: [BootstrapProbeController] })
export class BootstrapProbeModule {}
