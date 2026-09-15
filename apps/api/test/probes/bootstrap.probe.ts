import { Body, Controller, Get, Module, Post, type RawBodyRequest, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Access } from "../../src/common/access.decorator.ts";
import { RouteClass } from "../../src/common/route-classes.ts";

/** Probe routes for the bootstrap tests: prefixes, validation, body limits and raw bodies. */
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
}

@Module({ controllers: [BootstrapProbeController] })
export class BootstrapProbeModule {}
