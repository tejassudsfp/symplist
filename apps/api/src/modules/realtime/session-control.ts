import { wsCloseCodes } from "@symplist/contracts";
import type {
  AccessPostCommitHook,
  AccessRestrictedEvent,
  SessionsEndedEvent,
} from "@symplist/core/events";
import { errorCode, type OperationalLog } from "../../infra/scheduler/runtime.ts";
import type { AccessSweep } from "./access-sweep.ts";
import type { TopicHub } from "./topic-hub.ts";

/**
 * The gateway's post-commit effects (§5.1, §5.5): logout, session revocation and deletion close the
 * ended sessions' sockets with 4401; a restriction closes the user's admitted sockets with 4403 and
 * refreshes the access state of sockets that were only at identity level, which then receive
 * `access.changed` from the access feature.
 */
export class RealtimeSessionControl implements AccessPostCommitHook {
  constructor(
    private readonly options: {
      readonly hub: TopicHub;
      readonly sweep: AccessSweep;
      readonly log: OperationalLog;
    },
  ) {}

  async onSessionsEnded(event: SessionsEndedEvent): Promise<void> {
    const { hub } = this.options;
    hub.noteSessionsEnded(event.userId, event.sessionIds);
    const sockets =
      event.sessionIds === "all"
        ? hub.socketsOfUser(event.userId)
        : event.sessionIds.flatMap((sessionId) => hub.socketsOfSession(sessionId));
    let closed = 0;
    for (const socket of sockets) {
      if (socket.userId !== event.userId) continue;
      hub.close(socket, wsCloseCodes.sessionEnded, "session ended");
      closed += 1;
    }
    if (closed > 0) {
      this.options.log.info("realtime.sessions_ended", {
        userId: event.userId,
        reason: event.reason,
        closed,
      });
    }
  }

  async onAccessRestricted(event: AccessRestrictedEvent): Promise<void> {
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
      closed,
      identityLevel,
    });
  }
}
