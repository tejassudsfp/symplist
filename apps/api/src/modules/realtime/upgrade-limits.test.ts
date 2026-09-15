import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { LimitsProbeModule } from "../../../test/probes/limits.probe.ts";
import { rawUpgrade } from "../../../test/ws-client.ts";
import { forwardedForEntries, upgradeClientIp } from "../../infra/limits/client-ip.ts";
import { ipFailureBuckets } from "../../infra/limits/ip-limits.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function boot(hops: number): Promise<TestApp> {
  const app = await bootTestApp({
    env: { TRUST_PROXY_HOPS: String(hops) },
    imports: [LimitsProbeModule],
  });
  apps.push(app);
  return app;
}

const forged = (app: TestApp) =>
  `${app.sessionCookieName}=${randomBytes(32).toString("base64url")}`;

const upgrade = (app: TestApp, headers: Record<string, string> = {}) =>
  rawUpgrade(app.wsUrl, { origin: app.config.WEB_ORIGIN, cookie: forged(app), ...headers });

describe("upgrade client address (§5.8, §7)", () => {
  it("splits X-Forwarded-For exactly as Express's proxy-addr does", () => {
    expect(forwardedForEntries(undefined)).toEqual([]);
    expect(forwardedForEntries("")).toEqual([]);
    expect(forwardedForEntries("203.0.113.1")).toEqual(["203.0.113.1"]);
    expect(forwardedForEntries(" 203.0.113.1 ,  , 192.0.2.10 ")).toEqual([
      "192.0.2.10",
      "203.0.113.1",
    ]);
    expect(forwardedForEntries(["203.0.113.1", "192.0.2.10"])).toEqual([
      "192.0.2.10",
      "203.0.113.1",
    ]);
    expect(() => upgradeClientIp({ headers: {}, socket: {} as never }, -1)).toThrow(RangeError);
  });

  it("computes the same client address as Express under every TRUST_PROXY_HOPS value", async () => {
    const shapes = [
      undefined,
      "198.51.100.7",
      "203.0.113.1, 192.0.2.10",
      "10.0.0.1, 203.0.113.1, 192.0.2.10",
      " 203.0.113.1 ,, 192.0.2.10",
      "not-an-address, 192.0.2.10",
      "2001:db8::5, 192.0.2.10",
      "192.0.2.10, garbage",
    ];
    for (const hops of [0, 1, 2, 3]) {
      const app = await boot(hops);
      const peer = (await app.get("/.well-known/client-ip")).json<{ ip: string }>().ip;
      for (const header of shapes) {
        const response = await app.get("/.well-known/client-ip", {
          ...(header === undefined ? {} : { headers: { "x-forwarded-for": header } }),
        });
        const express = response.json<{ ip: string | null }>().ip;
        const computed = upgradeClientIp(
          {
            headers: header === undefined ? {} : { "x-forwarded-for": header },
            socket: { remoteAddress: peer } as never,
          },
          hops,
        );
        expect(computed, `hops ${hops}, header ${String(header)}`).toBe(express);
      }
    }
  });
});

describe("unknown session tokens on upgrades (§3.1, §5.8)", () => {
  it("refuses a client inventing tokens with 503 and Retry-After before D1, while cached sessions still connect", async () => {
    const app = await boot(0);
    const user = await app.createSignedInUser();
    // A live session's lookup is cached, so the bucket never refuses it.
    const accepted = await rawUpgrade(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: user.session.cookie,
    });
    expect(accepted.status).toBe(101);
    accepted.socket?.destroy();

    const { limit, windowMs } = ipFailureBuckets.session_unknown;
    for (let index = 0; index < limit; index += 1) {
      expect((await upgrade(app)).status).toBe(401);
    }
    const batch = vi.spyOn(app.db, "batch");
    const refused = await upgrade(app);
    expect(refused.status).toBe(503);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(batch).not.toHaveBeenCalled();
    batch.mockRestore();
    expect(app.logs.events("realtime.upgrade_rate_limited")).toHaveLength(1);

    const cached = await rawUpgrade(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: user.session.cookie,
    });
    expect(cached.status).toBe(101);
    cached.socket?.destroy();

    // HTTP requests from the same network share the bucket.
    const http = await app.get("/v1/auth/csrf", { headers: { cookie: forged(app) } });
    expect(http.status).toBe(503);

    await app.clock.advance(windowMs);
    expect((await upgrade(app)).status).toBe(401);
  });

  it("cannot be bypassed with a spoofed X-Forwarded-For when no proxy is trusted", async () => {
    const app = await boot(0);
    const { limit } = ipFailureBuckets.session_unknown;
    for (let index = 0; index < limit; index += 1) {
      const spoofed = `203.0.${Math.floor(index / 250)}.${(index % 250) + 1}`;
      expect((await upgrade(app, { "x-forwarded-for": spoofed })).status).toBe(401);
    }
    expect((await upgrade(app, { "x-forwarded-for": "198.51.100.77" })).status).toBe(503);
    expect((await upgrade(app)).status).toBe(503);
  });

  it("counts the address the trusted proxy appended, whatever the client prepended", async () => {
    const app = await boot(1);
    const { limit } = ipFailureBuckets.session_unknown;
    for (let index = 0; index < limit; index += 1) {
      const header = `10.${index % 250}.0.1, 192.0.2.10`;
      expect((await upgrade(app, { "x-forwarded-for": header })).status).toBe(401);
    }
    expect((await upgrade(app, { "x-forwarded-for": "8.8.8.8, 192.0.2.10" })).status).toBe(503);
    expect((await upgrade(app, { "x-forwarded-for": "192.0.2.10" })).status).toBe(503);
    // Another client behind the same proxy has its own bucket.
    expect((await upgrade(app, { "x-forwarded-for": "8.8.8.8, 192.0.2.11" })).status).toBe(401);
  });

  it("never counts cookies of ended sessions or upgrades without a well-formed token", async () => {
    const app = await boot(0);
    const { limit } = ipFailureBuckets.session_unknown;
    for (let index = 0; index < limit + 5; index += 1) {
      const ended = await app.createSignedInUser();
      await app.sessions.revoke({ userId: ended.id, sessionId: ended.session.sessionId });
      const response = await rawUpgrade(app.wsUrl, {
        origin: app.config.WEB_ORIGIN,
        cookie: ended.session.cookie,
      });
      expect(response.status).toBe(401);
    }
    for (let index = 0; index < limit + 5; index += 1) {
      const response = await rawUpgrade(app.wsUrl, {
        origin: app.config.WEB_ORIGIN,
        cookie: `${app.sessionCookieName}=malformed`,
      });
      expect(response.status).toBe(401);
    }
    expect((await upgrade(app)).status).toBe(401);
  });
});
