import { Module } from "@nestjs/common";
import { CsrfController } from "./csrf.controller.ts";
import { HealthController } from "./health.controller.ts";
import { HealthService } from "./health.service.ts";

/** Operational routes that belong to no feature: health and the session-bound CSRF token. */
@Module({
  controllers: [HealthController, CsrfController],
  providers: [HealthService],
})
export class SystemModule {}
