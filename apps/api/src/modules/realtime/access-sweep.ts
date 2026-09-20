import type { AccessState } from "@symplist/contracts";
import { wsCloseCodes } from "@symplist/contracts";
import { type DbClient, type DbRow, type Statement, sql } from "@symplist/db";
import {
  errorCode,
  type OperationalLog,
  type RuntimeTimers,
} from "../../infra/scheduler/runtime.ts";
import type { RealtimeSocketState, TopicHub } from "./topic-hub.ts";

/** At most this many session ids per statement, under D1's 100-parameter limit (§3.2). */
const SESSIONS_PER_STATEMENT = 90;

interface SessionAccessRow {
  readonly sessionId: string;
  readonly userId: string;
  readonly revokedAt: number | null;
  readonly expiresAt: number;
  readonly access: AccessState;
}

export interface SweepReport {
  readonly checked: number;
  readonly closedSession: number;
  readonly closedAccess: number;
}

function toRow(row: DbRow): SessionAccessRow | null {
  const betaState = row.beta_state;
  const onboardingStep = row.onboarding_step;
  const role = row.role;
  const deletionState = row.deletion_state;
  if (
    (betaState !== "locked" && betaState !== "unlocked" && betaState !== "relocked") ||
    (onboardingStep !== "name" && onboardingStep !== "connections" && onboardingStep !== "done") ||
    (role !== "member" && role !== "admin") ||
    (deletionState !== "none" && deletionState !== "deleting")
  ) {
    return null;
  }
  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    expiresAt: Number(row.expires_at),
    access: {
      emailVerifiedAt: row.email_verified_at === null ? null : Number(row.email_verified_at),
      betaState,
      suspendedAt: row.suspended_at === null ? null : Number(row.suspended_at),
      onboardingStep,
      role,
      accessGeneration: Number(row.access_generation),
      accessEpoch: Number(row.access_epoch),
      deletionState,
    },
  };
}

/**
 * The gateway's freshness check (§5.5): one batched D1 request (one statement per 90 sessions) reads
 * session revocation and expiry with the owner's access fields for every connected socket. A revoked,
 * expired or foreign session closes with 4401; lost access, or an admitted socket whose
 * `access_generation` moved, closes with 4403; otherwise the socket's access state is refreshed, so
 * admission changes take effect on the next subscription.
 *
 * The periodic sweep and `refreshUser` (after a restriction commits) run independently, so each takes
 * an access read ticket from the hub before reading D1: a result that returns after a newer read was
 * applied is ignored rather than re-admitting a socket the newer read restricted.
 */
export class AccessSweep {
  private timer: unknown;
  private running: Promise<SweepReport> | undefined;

  constructor(
    private readonly options: {
      readonly db: DbClient;
      readonly hub: TopicHub;
      readonly timers: RuntimeTimers;
      readonly log: OperationalLog;
      readonly intervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.options.timers.setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, this.options.intervalMs ?? 30_000);
  }

  stop(): void {
    if (this.timer !== undefined) this.options.timers.clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Sweeps every connected socket. Concurrent calls share one pass. */
  sweep(): Promise<SweepReport> {
    this.running ??= this.check(this.options.hub.connected()).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Re-reads the sessions of one user now, for example after a restriction commits. */
  refreshUser(userId: string): Promise<SweepReport> {
    return this.check(this.options.hub.socketsOfUser(userId));
  }

  private async check(sockets: readonly RealtimeSocketState[]): Promise<SweepReport> {
    const { hub, db, log, timers } = this.options;
    this.options.hub.evictIdleTopics();
    if (sockets.length === 0) return { checked: 0, closedSession: 0, closedAccess: 0 };
    const sessionIds = [...new Set(sockets.map((socket) => socket.sessionId))];
    const statements: Statement[] = [];
    for (let offset = 0; offset < sessionIds.length; offset += SESSIONS_PER_STATEMENT) {
      statements.push(
        sql(
          `SELECT s.id AS session_id, s.user_id, s.revoked_at, s.expires_at,
                  u.email_verified_at, u.beta_state, u.suspended_at, u.onboarding_step, u.role,
                  u.access_generation, u.access_epoch, u.deletion_state
           FROM auth_sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id IN (:sessions)`,
          { sessions: sessionIds.slice(offset, offset + SESSIONS_PER_STATEMENT) },
        ),
      );
    }
    const readTicket = hub.beginAccessRead();
    let rows: Map<string, SessionAccessRow>;
    try {
      const results = await db.batch(statements);
      rows = new Map();
      for (const result of results) {
        for (const raw of result.results) {
          const row = toRow(raw);
          if (row) rows.set(row.sessionId, row);
        }
      }
    } catch (error) {
      log.warn("realtime.sweep_failed", { sockets: sockets.length, code: errorCode(error) });
      return { checked: 0, closedSession: 0, closedAccess: 0 };
    }

    const now = timers.now();
    let closedSession = 0;
    let closedAccess = 0;
    for (const socket of sockets) {
      if (!hub.isConnected(socket)) continue;
      const row = rows.get(socket.sessionId);
      if (!row || row.userId !== socket.userId || row.revokedAt !== null || row.expiresAt <= now) {
        hub.close(
          socket,
          wsCloseCodes.sessionEnded,
          "session ended",
          row?.expiresAt !== undefined && row.expiresAt <= now ? "idle" : "revoked",
        );
        closedSession += 1;
        continue;
      }
      if (!hub.applyAccess(socket, row.access, readTicket)) {
        hub.close(socket, wsCloseCodes.accessLost, "access changed");
        closedAccess += 1;
      }
    }
    if (closedSession + closedAccess > 0) {
      log.info("realtime.sweep_closed", { checked: sockets.length, closedSession, closedAccess });
    }
    return { checked: sockets.length, closedSession, closedAccess };
  }
}
