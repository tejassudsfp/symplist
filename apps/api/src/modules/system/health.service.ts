import { Injectable } from "@nestjs/common";

export interface HealthStatus {
  status: "ok";
}

/** Liveness only: no auth, throttling or D1 call, so Render health checks stay cheap (§6). */
@Injectable()
export class HealthService {
  check(): HealthStatus {
    return { status: "ok" };
  }
}
