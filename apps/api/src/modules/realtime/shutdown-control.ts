import type { RealtimeShutdown } from "../../common/seams.ts";
import type { RealtimeGateway } from "./realtime.gateway.ts";

/**
 * The realtime side of graceful shutdown, bound to `REALTIME_SHUTDOWN` (§5.5, §7). The platform's
 * `ShutdownCoordinator` calls it before Nest drains HTTP: first relays stop (no upgrade is accepted and
 * nothing more is published, so run output pushed by the worker is refused with a retryable 503),
 * then every socket closes with 1001.
 */
export class RealtimeShutdownControl implements RealtimeShutdown {
  constructor(private readonly gateway: RealtimeGateway) {}

  async stopRelays(): Promise<void> {
    this.gateway.stopAccepting();
  }

  async closeAllSockets(code: 1001, timeoutMs: number): Promise<void> {
    await this.gateway.closeAll(code, timeoutMs);
  }
}
