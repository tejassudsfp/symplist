import { Controller, Get, Module, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Access } from "../../src/common/access.decorator.ts";
import { RouteClass } from "../../src/common/route-classes.ts";
import { clientIp } from "../../src/infra/limits/client-ip.ts";
import { IpFailureLimiter } from "../../src/infra/limits/ip-failures.ts";
import { IpLimit } from "../../src/infra/limits/ip-limits.ts";

/** Routes behind per-IP request and failure buckets (§5.8). */
@Controller()
export class LimitsProbeController {
  constructor(private readonly failures: IpFailureLimiter) {}

  @Post("auth/lookup")
  @RouteClass("pre_session")
  @IpLimit("auth_lookup")
  lookup(@Req() req: Request) {
    return { ip: clientIp(req) };
  }

  @Post("auth/signup")
  @RouteClass("pre_session")
  @IpLimit("auth_lookup")
  signup() {
    return { ok: true };
  }

  @Get("probe/ip")
  @RouteClass("app")
  @Access("identity")
  @IpLimit("invite_redeem")
  authenticated(@Req() req: Request) {
    return { ip: clientIp(req) };
  }

  @Post("artifact/:id/password")
  @RouteClass("share_form")
  password(@Req() req: Request) {
    this.failures.assertAllowed("share_password_failure", req);
    this.failures.recordFailure("share_password_failure", req);
    return { accepted: false };
  }
}

@Module({ controllers: [LimitsProbeController] })
export class LimitsProbeModule {}
