import type { IncomingMessage } from "node:http";
import type { SessionContext } from "@symplist/core/access";
import { errorCode, type OperationalLog } from "../../infra/scheduler/runtime.ts";
import type { AccessLevelPolicy } from "./topic-hub.ts";

/** The identity of an upgrade's session, with when that session was created (sign-in time). */
export interface UpgradeSession extends SessionContext {
  /** `auth_sessions.created_at`, UTC epoch milliseconds. */
  readonly sessionCreatedAt: number;
}

/**
 * Resolves the session cookie of a WebSocket upgrade through the core access session service (§5.1,
 * §7). Bearer tokens are ignored; only the session cookie counts (§5.2).
 */
export interface WsSessionResolver {
  /** The session behind the upgrade's cookie, or null when absent, invalid, expired or revoked. */
  fromUpgradeRequest(request: IncomingMessage): Promise<UpgradeSession | null>;
}

/** The whole seconds to wait when a lookup was refused with `rate.limited`, or null. */
function rateLimitRetryAfter(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, retryAfter } = error as { code?: unknown; retryAfter?: unknown };
  if (code !== "rate.limited") return null;
  return typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter > 0
    ? retryAfter
    : 1;
}

/** A session resolved for an upgrade, with the earliest instant its state may date from. */
export interface VerifiedUpgrade {
  readonly session: UpgradeSession;
  /**
   * When verification started, less the session cache TTL: the resolver may answer from a cache entry
   * up to that old (§3.3), so any logout or restriction after this instant may be missing from it.
   */
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
      /** The session and access cache TTL of the resolver (§3.3); defaults to 10 seconds. */
      readonly sessionCacheTtlMs?: number;
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
    // Taken before the lookup: a post-commit hook that runs while the session is being read (or that
    // the resolver's cache predates) must still refuse the connection.
    const verifiedAt = this.options.now() - (this.options.sessionCacheTtlMs ?? 10_000);
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
        this.sessions.set(info.req, { session, verifiedAt });
        callback(true);
      },
      (error: unknown) => {
        const retryAfter = rateLimitRetryAfter(error);
        if (retryAfter !== null) {
          // The client's network is over the unknown-session bucket (§5.8): refused before D1.
          this.options.log.warn("realtime.upgrade_rate_limited", { retryAfter });
          callback(false, 503, "Service Unavailable", { "Retry-After": String(retryAfter) });
          return;
        }
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
