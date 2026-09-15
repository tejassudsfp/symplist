import { Inject, Injectable, Optional } from "@nestjs/common";
import type { AccessLevel } from "@symplist/contracts";
import {
  type AccessDecision,
  type CreatedSession,
  csrfTokenForSession,
  evaluateAccess,
  isWellFormedSessionToken,
  type PreparedSession,
  type ResolvedSession,
  type SessionContext,
  SessionStore,
  type StatementGuard,
  verifyCsrfToken,
} from "@symplist/core/access";
import { computeDigest, type KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { Request, Response } from "express";
import { SessionCache } from "../../infra/cache/session-cache.ts";
import { TtlCache } from "../../infra/cache/ttl-cache.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { CLOCK, type Clock } from "../clock.ts";
import { AppLogger } from "../logging/logger.ts";
import { REALTIME_ACCESS_NOTIFIER, type RealtimeAccessNotifier } from "../seams.ts";
import { clearSessionCookies, cookieNames, setSessionCookies } from "./session-cookies.ts";

/**
 * Login sessions for the api (§3.3, §5.1): resolves the session cookie through the 10-second cache
 * (or fresh from D1 for the sensitive operations), records activity at most every 5 minutes without
 * delaying the request, sets and clears cookies, and revokes sessions with cache eviction and socket
 * closing.
 */
@Injectable()
export class SessionService {
  readonly store: SessionStore;
  private readonly cache: SessionCache;
  private readonly touched: TtlCache<string, true>;
  private readonly pendingTouches = new Set<Promise<void>>();

  constructor(
    @Inject(DB_CLIENT) db: DbClient,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: AppLogger,
    @Optional()
    @Inject(REALTIME_ACCESS_NOTIFIER)
    private readonly realtime?: RealtimeAccessNotifier,
  ) {
    this.store = new SessionStore({ db, keys });
    this.cache = new SessionCache({ clock });
    this.touched = new TtlCache({ clock, ttlMs: 5 * 60 * 1000, maxEntries: 50_000 });
  }

  /** The session token presented in the request's session cookie, if it is well formed. */
  tokenFrom(req: Request): string | null {
    const value = (req.cookies as Record<string, unknown> | undefined)?.[
      cookieNames(this.config).session
    ];
    return isWellFormedSessionToken(value) ? value : null;
  }

  /**
   * The session token in a raw `Cookie` header, for requests cookie-parser never saw, such as the
   * WebSocket upgrade (§7).
   */
  tokenFromCookieHeader(header: string | readonly string[] | undefined): string | null {
    const text = Array.isArray(header) ? header.join("; ") : header;
    if (typeof text !== "string") return null;
    const name = cookieNames(this.config).session;
    for (const part of text.split(";")) {
      const separator = part.indexOf("=");
      if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
      const value = part.slice(separator + 1).trim();
      return isWellFormedSessionToken(value) ? value : null;
    }
    return null;
  }

  /**
   * Resolves the request's session. Cached entries are served for at most 10 seconds; `fresh` always
   * reads D1 and refreshes the cache (§3.3). Unknown tokens are remembered for 60 seconds.
   */
  async resolve(
    req: Request,
    options: { readonly fresh: boolean },
  ): Promise<ResolvedSession | null> {
    return this.resolveToken(this.tokenFrom(req), options);
  }

  /** Resolves a session token taken from a cookie, with the same caching as {@link resolve}. */
  async resolveToken(
    token: string | null,
    options: { readonly fresh: boolean },
  ): Promise<ResolvedSession | null> {
    if (!token || !isWellFormedSessionToken(token)) return null;
    const key = computeDigest(this.keys, "SESSION_DIGEST_SECRET", "session", token).digest;
    if (!options.fresh) {
      if (this.cache.isKnownMissing(key)) return null;
      const cached = this.cache.get(key);
      if (cached) return cached;
    }
    const now = this.clock.now();
    const resolved = await this.store.resolve(token, now);
    if (!resolved) {
      this.cache.rememberMissing(key);
      return null;
    }
    this.cache.evictStaleGeneration(resolved.session.userId, resolved.access.accessGeneration);
    this.cache.set(key, resolved);
    this.touchLater(resolved, now);
    return resolved;
  }

  /** Evaluates a guard level for a resolved session, honoring `BETA_ACCESS_REQUIRED` (§5.4). */
  evaluate(resolved: ResolvedSession, level: AccessLevel): AccessDecision {
    return evaluateAccess(resolved.access, level, {
      betaAccessRequired: this.config.BETA_ACCESS_REQUIRED,
    });
  }

  /** The request-scoped identity for a resolved session. */
  contextOf(resolved: ResolvedSession): SessionContext {
    return Object.freeze({
      userId: resolved.session.userId,
      sessionId: resolved.session.id,
      access: resolved.access,
    });
  }

  /**
   * A fresh D1 read of a session's access for work outside an HTTP guard, such as run dispatch
   * (§3.3). Returns null when the token no longer resolves.
   */
  async loadFresh(req: Request): Promise<SessionContext | null> {
    const resolved = await this.resolve(req, { fresh: true });
    return resolved ? this.contextOf(resolved) : null;
  }

  /** The session-bound CSRF token served by `GET /v1/auth/csrf` (§5.3). */
  csrfToken(sessionId: string): string {
    return csrfTokenForSession(this.keys, sessionId);
  }

  /** Whether a presented `X-Symplist-CSRF` value is the token of this session. */
  verifyCsrf(sessionId: string, presented: unknown): boolean {
    return verifyCsrfToken(this.keys, sessionId, presented);
  }

  /** Statements that create a session, to fold into the authenticating batch (OTP verify, §5.1). */
  prepare(userId: string, guard?: StatementGuard): PreparedSession {
    return this.store.prepareCreate({ userId, now: this.clock.now(), ...(guard ? { guard } : {}) });
  }

  /** Sets `sym_session`/`__Host-sym_session` and `sym_hint` for a created session. */
  setCookies(res: Response, session: CreatedSession): void {
    setSessionCookies(res, this.config, session, this.clock.now());
  }

  /** Clears the session, Vault and hint cookies. */
  clearCookies(res: Response): void {
    clearSessionCookies(res, this.config);
  }

  /** Revokes one session (logout): evicts its cache entries and closes its sockets with 4401. */
  async revoke(context: Pick<SessionContext, "userId" | "sessionId">): Promise<boolean> {
    const revoked = await this.store.revoke({
      sessionId: context.sessionId,
      userId: context.userId,
      now: this.clock.now(),
    });
    this.cache.evictSession(context.sessionId);
    if (revoked) await this.notifySessionsEnded(context.userId, [context.sessionId]);
    return revoked;
  }

  /** Revokes every session of a user: evicts the user's cache entries and closes their sockets. */
  async revokeAll(userId: string): Promise<readonly string[]> {
    const ids = await this.store.revokeAll({ userId, now: this.clock.now() });
    this.cache.evictUser(userId);
    if (ids.length > 0) await this.notifySessionsEnded(userId, ids);
    return ids;
  }

  /** Evicts every cached session of a user (after restrictions, restores and access changes). */
  evictUser(userId: string): void {
    this.cache.evictUser(userId);
  }

  private async notifySessionsEnded(
    userId: string,
    sessionIds: readonly string[] | null,
  ): Promise<void> {
    if (!this.realtime) return;
    try {
      await this.realtime.sessionsEnded({ userId, sessionIds });
    } catch (error) {
      this.logger.warn("session.realtime_notify_failed", { error });
    }
  }

  private touchLater(resolved: ResolvedSession, now: number): void {
    const { session } = resolved;
    if (!this.store.isTouchDue(session, now) || this.touched.has(session.id)) return;
    this.touched.set(session.id, true);
    const pending = this.store
      .touch(session.id, now)
      .catch((error: unknown) => {
        this.touched.delete(session.id);
        this.logger.warn("session.touch_failed", { error });
      })
      .finally(() => this.pendingTouches.delete(pending));
    this.pendingTouches.add(pending);
  }

  /** Waits for last-seen writes still in flight; called during shutdown before the database closes. */
  async drain(): Promise<void> {
    await Promise.all([...this.pendingTouches]);
  }
}
