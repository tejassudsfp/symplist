import { Body, Controller, Get, Module, Post, Query } from "@nestjs/common";
import { Access } from "../../src/common/access.decorator.ts";
import { AppLogger } from "../../src/common/logging/logger.ts";
import { RouteClass } from "../../src/common/route-classes.ts";

/** Routes that try to log credentials and content, for the redaction tests (§6.3). */
@Controller()
export class LoggingProbeController {
  constructor(private readonly logger: AppLogger) {}

  @Post("auth/probe-login")
  @RouteClass("pre_session")
  login(@Body() body: Record<string, unknown>) {
    this.logger.info("probe.login_attempt", { ...body, attempt: 1 });
    return { ok: true };
  }

  @Get("artifact/:id")
  @RouteClass("share_read")
  share(@Query("key") key: string) {
    this.logger.info("probe.share_read", { key, length: key.length });
    return { ok: true };
  }

  @Post("probe/fail")
  @RouteClass("app")
  @Access("identity")
  fail(@Body() body: { prompt: string }) {
    const error = new Error(`upstream rejected prompt: ${body.prompt}`);
    Object.assign(error, { code: "integration.rejected", detail: body.prompt });
    throw error;
  }
}

@Module({ controllers: [LoggingProbeController] })
export class LoggingProbeModule {}
