import { Module } from "@nestjs/common";
import { BugReportsController } from "./bug-reports.controller.ts";
import { BugReportsService } from "./bug-reports.service.ts";
import { CsrfController } from "./csrf.controller.ts";
import { HealthController } from "./health.controller.ts";
import { HealthService } from "./health.service.ts";

/**
 * Operational routes that belong to no feature: health, the session-bound CSRF token, and bug reports
 * — which come from every surface and are owned by none of them.
 */
@Module({
  controllers: [HealthController, CsrfController, BugReportsController],
  providers: [HealthService, BugReportsService],
})
export class SystemModule {}
