import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { ServerAnalyticsEmitter } from "@symplist/analytics/server";
import type { ManagedKeyProvider } from "@symplist/crypto";
import type { D1Counters } from "@symplist/db";
import { SERVER_ANALYTICS } from "../../infra/analytics/analytics.providers.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { API_DATABASE, type ApiDatabase, D1_COUNTERS } from "../../infra/db/db.providers.ts";
import { SessionService } from "../auth/session.service.ts";
import { AppLogger } from "../logging/logger.ts";
import { platformSeams, REALTIME_SHUTDOWN, type RealtimeShutdown } from "../seams.ts";

/** Sockets get this long to close with 1001 before HTTP draining starts (§7). */
export const SOCKET_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Graceful shutdown in the order §5.5 and §7 require. Nest runs `beforeApplicationShutdown` before it
 * closes the HTTP server, so relays stop and sockets close with 1001 first; the Express adapter then
 * drains in-flight requests; `onApplicationShutdown` finally flushes analytics, stops the D1
 * counters, closes the database and zeroizes the keys, after nothing can use them.
 */
@Injectable()
export class ShutdownCoordinator
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private stopCounters: (() => void) | undefined;

  constructor(
    private readonly logger: AppLogger,
    private readonly sessions: SessionService,
    private readonly moduleRef: ModuleRef,
    @Inject(API_DATABASE) private readonly database: ApiDatabase,
    @Inject(D1_COUNTERS) private readonly counters: D1Counters,
    @Inject(KEY_PROVIDER) private readonly keys: ManagedKeyProvider,
    @Inject(SERVER_ANALYTICS) private readonly analytics: ServerAnalyticsEmitter,
    @Optional() @Inject(REALTIME_SHUTDOWN) private readonly realtime?: RealtimeShutdown,
  ) {}

  onApplicationBootstrap(): void {
    this.stopCounters = this.counters.start((snapshot) =>
      this.logger.info("d1.counters", { ...snapshot }),
    );
    for (const [seam, token] of Object.entries(platformSeams)) {
      let bound = false;
      try {
        bound = this.moduleRef.get(token, { strict: false }) !== undefined;
      } catch {
        bound = false;
      }
      if (!bound) this.logger.warn("platform.seam_unbound", { seam });
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.realtime) return;
    try {
      await this.realtime.stopRelays();
    } catch (error) {
      this.logger.warn("shutdown.relay_stop_failed", { error });
    }
    try {
      await this.realtime.closeAllSockets(1001, SOCKET_CLOSE_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn("shutdown.socket_close_failed", { error });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.analytics.shutdown();
    this.stopCounters?.();
    await this.sessions.drain();
    this.database.close();
    this.keys.destroy();
  }
}
