import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.ts";
import { HealthService } from "./health.service.ts";

/** Operational routes that belong to no feature. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class SystemModule {}
