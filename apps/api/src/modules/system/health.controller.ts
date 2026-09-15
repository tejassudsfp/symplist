import { Controller, Get } from "@nestjs/common";
import { HealthService, type HealthStatus } from "./health.service.ts";

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("healthz")
  healthz(): HealthStatus {
    return this.health.check();
  }
}
