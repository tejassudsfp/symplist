import type { IncomingMessage } from "node:http";
import type { SessionService } from "../../common/auth/session.service.ts";
import { upgradeClientIp } from "../../infra/limits/client-ip.ts";
import type { UpgradeSession, WsSessionResolver } from "./upgrade-gate.ts";

/**
 * Resolves the session cookie of a WebSocket upgrade through the api's `SessionService` (§5.1, §7):
 * the raw `Cookie` header (cookie-parser never sees upgrades) through the same 10-second cache, and
 * lookups that name no session counted in the `session_unknown` failure bucket under the client
 * address `TRUST_PROXY_HOPS` yields, exactly as HTTP requests are (§3.1, §5.8). Bearer tokens are
 * never read (§5.2). A client over the bucket makes the lookup throw `rate.limited`.
 */
export class SessionUpgradeResolver implements WsSessionResolver {
  constructor(
    private readonly options: {
      readonly sessions: SessionService;
      readonly trustProxyHops: number;
    },
  ) {}

  async fromUpgradeRequest(request: IncomingMessage): Promise<UpgradeSession | null> {
    const { sessions, trustProxyHops } = this.options;
    const token = sessions.tokenFromCookieHeader(request.headers.cookie);
    if (token === null) return null;
    const resolved = await sessions.resolveUpgrade(token, upgradeClientIp(request, trustProxyHops));
    if (!resolved) return null;
    return Object.freeze({
      ...sessions.contextOf(resolved),
      sessionCreatedAt: resolved.session.createdAt,
    });
  }
}
