import { Controller, Get } from "@nestjs/common";
import { RouteClass } from "../../common/route-classes.ts";
import { HealthService, type HealthStatus } from "./health.service.ts";

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("healthz")
  @RouteClass("public_read")
  healthz(): HealthStatus {
    return this.health.check();
  }
}
