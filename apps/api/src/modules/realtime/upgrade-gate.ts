import type { IncomingMessage } from "node:http";
import type { SessionContext } from "@symplist/core/access";
import { errorCode, type OperationalLog } from "../../infra/scheduler/runtime.ts";
import type { AccessLevelPolicy } from "./topic-hub.ts";

/**
 * Resolves the session cookie of a WebSocket upgrade through the core access session service (§5.1,
 * §7). Bearer tokens are ignored; only the session cookie counts (§5.2).
 */
export interface WsSessionResolver {
  /** The session behind the upgrade's cookie, or null when absent, invalid, expired or revoked. */
  fromUpgradeRequest(request: IncomingMessage): Promise<SessionContext | null>;
}

/** A session resolved for an upgrade, with when it was read. */
export interface VerifiedUpgrade {
  readonly session: SessionContext;
  readonly verifiedAt: number;
}

/** `ws`'s `verifyClient` info. */
export interface VerifyClientInfo {
  readonly origin: string | undefined;
  readonly secure: boolean;
  readonly req: IncomingMessage;
}

export type VerifyClientCallback = (
  result: boolean,
  code?: number,
  message?: string,
  headers?: Record<string, string>,
) => void;

/**
 * Authenticates WebSocket upgrades before the 101 response (§7): the `Origin` allowlist first, then
 * the session cookie through the session resolver, then the identity access level. The resolved
 * session is handed to the gateway through a weak map, never attached to the request object.
 */
export class RealtimeUpgradeGate {
  private readonly sessions = new WeakMap<IncomingMessage, VerifiedUpgrade>();
  private readonly origins: ReadonlySet<string>;
  private closed = false;

  constructor(
    private readonly options: {
      readonly allowedOrigins: readonly string[];
      readonly resolver: WsSessionResolver;
      readonly access: AccessLevelPolicy;
      readonly log: OperationalLog;
      readonly now: () => number;
    },
  ) {
    this.origins = new Set(options.allowedOrigins);
    if (this.origins.size === 0) throw new Error("The WebSocket gateway needs an Origin allowlist");
  }

  /** Refuses every later upgrade (shutdown). */
  close(): void {
    this.closed = true;
  }

  verify(info: VerifyClientInfo, callback: VerifyClientCallback): void {
    if (this.closed) {
      callback(false, 503, "Service Unavailable");
      return;
    }
    const origin = typeof info.origin === "string" ? info.origin : undefined;
    if (origin === undefined || !this.origins.has(origin)) {
      callback(false, 403, "Forbidden");
      return;
    }
    this.options.resolver.fromUpgradeRequest(info.req).then(
      (session) => {
        if (!session) {
          callback(false, 401, "Unauthorized");
          return;
        }
        if (!this.options.access.satisfies(session.access, "identity")) {
          callback(false, 403, "Forbidden");
          return;
        }
        this.sessions.set(info.req, { session, verifiedAt: this.options.now() });
        callback(true);
      },
      (error: unknown) => {
        this.options.log.error("realtime.upgrade_session_failed", { code: errorCode(error) });
        callback(false, 500, "Internal Server Error");
      },
    );
  }

  /** The session verified for an upgrade request, removed once read. */
  take(request: IncomingMessage): VerifiedUpgrade | undefined {
    const session = this.sessions.get(request);
    this.sessions.delete(request);
    return session;
  }
}
