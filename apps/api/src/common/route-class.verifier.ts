import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { AppLogger } from "./logging/logger.ts";
import {
  collectRoutesFromContainer,
  RouteClassViolationError,
  routeClassViolations,
} from "./route-registry.ts";

/**
 * Fails bootstrap when any controller route lacks a route class or breaks its rules (§5.3), so a
 * misconfigured route can never serve traffic.
 */
@Injectable()
export class RouteClassVerifier implements OnApplicationBootstrap {
  constructor(
    private readonly modules: ModulesContainer,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    const problems = routeClassViolations(collectRoutesFromContainer(this.modules));
    if (problems.length > 0) {
      this.logger.error("route_class.violations", { count: problems.length });
      throw new RouteClassViolationError(problems);
    }
  }
}
