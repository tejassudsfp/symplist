import { Inject, Injectable } from "@nestjs/common";
import type { AccessState } from "@symplist/contracts";
import type { RealtimePublisher } from "@symplist/core/events";
import { SessionService } from "../../common/auth/session.service.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { AccessSweep } from "../realtime/access-sweep.ts";
import { REALTIME_PUBLISHER } from "../realtime/realtime.tokens.ts";

/**
 * Access-state notifications (§5.4, §7): after a change to an account's access fields commits, the
 * account's cached sessions are evicted, sockets that were only at identity level are re-read (so an
 * unlock admits them), and `access.changed` is published on the account's `user` topic, which also
 * reaches sockets that are not admitted and forces the client to the correct gate. Restrictions close
 * admitted sockets through the platform's post-commit effects before this runs. Failures are logged,
 * never thrown: the commit already happened and the 30-second sweep is the backstop.
 */
@Injectable()
export class AccessRealtime {
  constructor(
    @Inject(REALTIME_PUBLISHER) private readonly publisher: RealtimePublisher,
    @Inject(AccessSweep) private readonly sweep: AccessSweep,
    private readonly sessions: SessionService,
    private readonly logger: AppLogger,
  ) {}

  async accessChanged(
    userId: string,
    access: AccessState,
    options: { readonly generationMoved: boolean },
  ): Promise<void> {
    if (options.generationMoved) this.sessions.evictUser(userId, access.accessGeneration);
    else this.sessions.evictUser(userId);
    try {
      await this.sweep.refreshUser(userId);
    } catch (error) {
      this.logger.warn("access.realtime_refresh_failed", { userId, error });
    }
    try {
      await this.publisher.publishToUser(userId, {
        type: "access.changed",
        data: { accessState: access },
      });
    } catch (error) {
      this.logger.warn("access.realtime_publish_failed", { userId, error });
    }
  }
}
