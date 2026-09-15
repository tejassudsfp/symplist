import { Controller, Get, Module, Post } from "@nestjs/common";
import type { SessionContext } from "@symplist/core/access";
import { Access, CurrentSession } from "../../src/common/access.decorator.ts";
import { RouteClass } from "../../src/common/route-classes.ts";

/** One route per access level, plus a fresh-read route (§3.3, §5.4). */
@Controller("levels")
@RouteClass("app")
export class AccessLevelsProbeController {
  @Get("identity")
  @Access("identity")
  identity(@CurrentSession() session: SessionContext) {
    return { userId: session.userId, sessionId: session.sessionId };
  }

  @Get("admitted")
  @Access("admitted")
  admitted(@CurrentSession() session: SessionContext) {
    return { userId: session.userId };
  }

  @Get("admin")
  @Access("admin")
  admin() {
    return { ok: true };
  }

  @Post("sensitive")
  @Access("admitted", { fresh: true })
  sensitive(@CurrentSession() session: SessionContext) {
    return { generation: session.access.accessGeneration };
  }
}

@Module({ controllers: [AccessLevelsProbeController] })
export class AccessLevelsProbeModule {}
