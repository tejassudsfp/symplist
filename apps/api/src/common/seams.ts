import type { RestrictionReason } from "@symplist/contracts";

/**
 * Interfaces the platform calls but the realtime and executor builders implement (§5.5, §7, §8.1).
 * An implementation is bound by providing the token from a global module (or through
 * `AppModule.forRoot({ providers })`); the platform injects each one optionally and logs
 * `platform.seam_unbound` at startup when one is missing.
 */

/** Injection token for {@link RealtimeAccessNotifier}. */
export const REALTIME_ACCESS_NOTIFIER = "symplist:REALTIME_ACCESS_NOTIFIER";

/** What the WebSocket gateway does when access or a session ends (§5.1, §5.5, §7). */
export interface RealtimeAccessNotifier {
  /**
   * A restriction committed: close the user's admitted sockets with 4403 and publish
   * `access.changed` to any remaining identity-level socket.
   */
  accessRestricted(event: {
    readonly userId: string;
    readonly reason: RestrictionReason;
    readonly accessGeneration: number;
  }): Promise<void>;
  /** Sessions were revoked (logout, revocation, account deletion): close their sockets with 4401. */
  sessionsEnded(event: {
    readonly userId: string;
    readonly sessionIds: readonly string[] | null;
  }): Promise<void>;
}

/** Injection token for {@link RunCanceller}. */
export const RUN_CANCELLER = "symplist:RUN_CANCELLER";

/** Cancels executor work after a restriction (§5.5, §8.1). */
export interface RunCanceller {
  /** Calls Trigger `runs.cancel` (or aborts local runs) for the user's runs a restriction cancelled. */
  cancelRestrictedRuns(event: {
    readonly userId: string;
    readonly accessGeneration: number;
  }): Promise<void>;
}

/** Injection token for {@link RealtimeShutdown}. */
export const REALTIME_SHUTDOWN = "symplist:REALTIME_SHUTDOWN";

/** The realtime side of graceful shutdown (§5.5, §7). */
export interface RealtimeShutdown {
  /** Stops relaying run output to sockets. */
  stopRelays(): Promise<void>;
  /** Closes every socket with 1001 and resolves once they closed or `timeoutMs` passed. */
  closeAllSockets(code: 1001, timeoutMs: number): Promise<void>;
}

/** Injection token for the Trigger.dev client the dispatcher, reconciler and purge use (§8.1). */
export const TRIGGER_CLIENT = "symplist:TRIGGER_CLIENT";

/** The platform seams checked at startup, with the tokens that bind them. */
export const platformSeams = Object.freeze({
  realtimeAccessNotifier: REALTIME_ACCESS_NOTIFIER,
  runCanceller: RUN_CANCELLER,
  realtimeShutdown: REALTIME_SHUTDOWN,
} as const);
