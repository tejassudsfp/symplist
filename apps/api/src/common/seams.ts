import type { RestrictionReason } from "@symplist/contracts";
import type { TriggerRunsClient } from "../infra/executors/executor.ts";

/**
 * Interfaces the platform calls after a commit and during shutdown (§5.1, §5.5, §7, §8.1), with the
 * one definition of each injection token. `PlatformSeamsModule` binds every token from the realtime
 * and executor implementations; the platform injects each one optionally and logs
 * `platform.seam_unbound` at startup when one is missing. Tests replace a binding with
 * `overrides: [{ token, value }]` (or `providers`, which the platform's own services see first).
 */

/** Injection token for {@link RealtimeAccessNotifier}. */
export const REALTIME_ACCESS_NOTIFIER = "symplist:REALTIME_ACCESS_NOTIFIER";

/** Why login sessions ended (§5.1); carried for operational logs only. */
export type SessionEndReason = "logout" | "revoked";

/** What the WebSocket gateway does when access or a session ends (§5.1, §5.5, §7). */
export interface RealtimeAccessNotifier {
  /**
   * A restriction committed: close the user's admitted sockets with 4403 (every socket for
   * `deleted`) and refresh the access state of identity-level sockets, which then receive
   * `access.changed` from the access feature.
   */
  accessRestricted(event: {
    readonly userId: string;
    readonly reason: RestrictionReason;
    readonly accessGeneration: number;
  }): Promise<void>;
  /** Sessions were revoked (logout, revocation): close exactly their sockets with 4401. */
  sessionsEnded(event: {
    readonly userId: string;
    readonly sessionIds: readonly string[];
    readonly reason: SessionEndReason;
  }): Promise<void>;
}

/** Injection token for {@link RunCanceller}. */
export const RUN_CANCELLER = "symplist:RUN_CANCELLER";

/** Stops executor work after a restriction (§5.5, §8.1). */
export interface RunCanceller {
  /**
   * The restriction batch requested the stop of the user's queued and running work: abort the local
   * jobs, or call Trigger `runs.cancel` for the durable runs.
   */
  cancelRestrictedRuns(event: {
    readonly userId: string;
    readonly accessGeneration: number;
  }): Promise<void>;
}

/** Injection token for {@link RealtimeShutdown}. */
export const REALTIME_SHUTDOWN = "symplist:REALTIME_SHUTDOWN";

/** The realtime side of graceful shutdown (§5.5, §7). */
export interface RealtimeShutdown {
  /** Refuses new upgrades and stops relaying run output and publishing to sockets. */
  stopRelays(): Promise<void>;
  /** Closes every socket with 1001 and resolves once they closed or `timeoutMs` passed. */
  closeAllSockets(code: 1001, timeoutMs: number): Promise<void>;
}

/**
 * Injection token for the Trigger.dev client the dispatcher, reconciler and restriction canceller use
 * (§8.1): the SDK client built from `TRIGGER_SECRET_KEY` when `DURABLE=true`, and null otherwise, so a
 * local-mode api never holds Trigger credentials. Tests bind a `FakeTriggerClient`.
 */
export const TRIGGER_CLIENT = "symplist:TRIGGER_CLIENT";

/** The value bound to {@link TRIGGER_CLIENT}. */
export type TriggerClientBinding = TriggerRunsClient | null;

/** The platform seams checked at startup, with the tokens that bind them. */
export const platformSeams = Object.freeze({
  realtimeAccessNotifier: REALTIME_ACCESS_NOTIFIER,
  runCanceller: RUN_CANCELLER,
  realtimeShutdown: REALTIME_SHUTDOWN,
} as const);
