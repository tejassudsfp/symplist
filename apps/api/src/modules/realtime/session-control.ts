import { wsCloseCodes } from "@symplist/contracts";
import type { RealtimeAccessNotifier } from "../../common/seams.ts";
import { errorCode, type OperationalLog } from "../../infra/scheduler/runtime.ts";
import type { AccessSweep } from "./access-sweep.ts";
import type { TopicHub } from "./topic-hub.ts";

/**
 * The gateway's post-commit effects, bound to `REALTIME_ACCESS_NOTIFIER` (§5.1, §5.5): logout and
 * session revocation close exactly the ended sessions' sockets with 4401; a restriction closes the
 * user's admitted sockets (every socket for `deleted`) with 4403 and refreshes the access state of
 * sockets that were only at identity level, which then receive `access.changed` from the access
 * feature. Both remember the change for a minute, so an upgrade verified before it cannot open a socket
 * on the stale session or access state.
 */
export class RealtimeSessionControl implements RealtimeAccessNotifier {
  constructor(
    private readonly options: {
      readonly hub: TopicHub;
      readonly sweep: AccessSweep;
      readonly log: OperationalLog;
    },
  ) {}

  async sessionsEnded(
    event: Parameters<RealtimeAccessNotifier["sessionsEnded"]>[0],
  ): Promise<void> {
    const { hub } = this.options;
    hub.noteSessionsEnded(event.userId, event.sessionIds);
    let closed = 0;
    for (const sessionId of event.sessionIds) {
      for (const socket of hub.socketsOfSession(sessionId)) {
        // A session id that belongs to another user never closes that user's socket.
        if (socket.userId !== event.userId) continue;
        hub.close(socket, wsCloseCodes.sessionEnded, "session ended", event.reason);
        closed += 1;
      }
    }
    if (closed > 0) {
      this.options.log.info("realtime.sessions_ended", {
        userId: event.userId,
        reason: event.reason,
        closed,
      });
    }
  }

  async accessRestricted(
    event: Parameters<RealtimeAccessNotifier["accessRestricted"]>[0],
  ): Promise<void> {
    const { hub, sweep, log } = this.options;
    hub.noteAccessChanged(event.userId);
    let closed = 0;
    let identityLevel = 0;
    for (const socket of hub.socketsOfUser(event.userId)) {
      if (socket.admitted || event.reason === "deleted") {
        hub.close(socket, wsCloseCodes.accessLost, "access changed");
        closed += 1;
      } else {
        identityLevel += 1;
      }
    }
    if (identityLevel > 0) {
      try {
        await sweep.refreshUser(event.userId);
      } catch (error) {
        log.warn("realtime.restriction_refresh_failed", {
          userId: event.userId,
          code: errorCode(error),
        });
      }
    }
    log.info("realtime.access_restricted", {
      userId: event.userId,
      reason: event.reason,
      accessGeneration: event.accessGeneration,
      closed,
      identityLevel,
    });
  }
}
