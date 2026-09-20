import type { INestApplicationContext } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import {
  RealtimeUpgradeGate,
  type VerifyClientCallback,
  type VerifyClientInfo,
} from "./upgrade-gate.ts";

/**
 * The `ws` adapter with async `verifyClient` (§7): every upgrade passes the realtime upgrade gate
 * (Origin allowlist, then the session cookie) before the 101 response. Install it in the bootstrap
 * with `app.useWebSocketAdapter(new AuthWsAdapter(app))` before `listen`.
 */
export class AuthWsAdapter extends WsAdapter {
  constructor(private readonly appContext: INestApplicationContext) {
    super(appContext);
  }

  override create(
    port: number,
    options: Record<string, unknown> & { namespace?: string; server?: unknown; path?: string } = {},
  ) {
    const gate = this.appContext.get(RealtimeUpgradeGate, { strict: false });
    return super.create(port, {
      ...options,
      verifyClient: (info: VerifyClientInfo, callback: VerifyClientCallback) =>
        gate.verify(info, callback),
    });
  }
}
