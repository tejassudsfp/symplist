import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { FakeClock } from "@symplist/testing";
import type { Request } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { LimitsProbeController, LimitsProbeModule } from "../../../test/probes/limits.probe.ts";
import { clientIp, ipBucketKey } from "./client-ip.ts";
import { DurableCounterService } from "./durable-counter.ts";
import { FixedWindowCounters } from "./fixed-window.ts";
import { ipRequestBuckets } from "./ip-limits.ts";
import { ClockThrottlerStorage, IpThrottlerGuard, ipThrottlerOptions } from "./ip-throttler.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function boot(env: Record<string, string> = {}): Promise<TestApp> {
  const app = await bootTestApp({ imports: [LimitsProbeModule], env });
  apps.push(app);
  return app;
}

const lookup = (app: TestApp, headers: Record<string, string> = {}) =>
  app.post("/v1/auth/lookup", { csrf: "1", headers });

describe("in-memory per-IP buckets (§5.8)", () => {
  it("refuses the request past the bucket with rate.limited and Retry-After, before any D1 access", async () => {
    const app = await boot();
    const { limit, windowMs } = ipRequestBuckets.auth_lookup;
    for (let index = 0; index < limit - 1; index += 1) {
      expect((await lookup(app)).status).toBe(201);
    }
    // Lookup and signup share one bucket.
    expect((await app.post("/v1/auth/signup", { csrf: "1" })).status).toBe(201);

    const batch = vi.spyOn(app.db, "batch");
    const refused = await lookup(app);
    expect(refused.status).toBe(503);
    expect(refused.json()).toMatchObject({
      error: { code: "rate.limited", details: { retryAfter: windowMs / 1000 } },
    });
    expect(refused.headers.get("retry-after")).toBe(String(windowMs / 1000));
    expect(batch).not.toHaveBeenCalled();

    await app.clock.advance(windowMs);
    expect((await lookup(app)).status).toBe(201);
  });

  it("throttles authenticated routes before the session lookup", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    for (let index = 0; index < ipRequestBuckets.invite_redeem.limit; index += 1) {
      expect((await app.get("/v1/probe/ip", { session })).status).toBe(200);
    }
    await app.clock.advance(20_000);
    const batch = vi.spyOn(app.db, "batch");
    expect((await app.get("/v1/probe/ip", { session })).status).toBe(503);
    expect(batch).not.toHaveBeenCalled();
  });

  it("cannot be reset by a client-supplied X-Forwarded-For when no proxy is trusted", async () => {
    const app = await boot({ TRUST_PROXY_HOPS: "0" });
    const seen = new Set<unknown>();
    for (let index = 0; index < ipRequestBuckets.auth_lookup.limit; index += 1) {
      const response = await lookup(app, { "x-forwarded-for": `203.0.113.${index + 1}` });
      expect(response.status).toBe(201);
      seen.add(response.json<{ ip: string }>().ip);
    }
    expect([...seen]).toHaveLength(1);
    expect([...seen][0]).toMatch(/^(127\.0\.0\.1|::1)$/);
    const spoofed = await lookup(app, { "x-forwarded-for": "198.51.100.77" });
    expect(spoofed.status).toBe(503);
  });

  it("tracks the address the trusted proxy appended, ignoring values the client prepended", async () => {
    const app = await boot({ TRUST_PROXY_HOPS: "1" });
    // The proxy appends the real peer (192.0.2.10); everything before it came from the client.
    const first = await lookup(app, { "x-forwarded-for": "203.0.113.1, 192.0.2.10" });
    expect(first.json()).toEqual({ ip: "192.0.2.10" });
    for (let index = 1; index < ipRequestBuckets.auth_lookup.limit; index += 1) {
      const response = await lookup(app, { "x-forwarded-for": `10.9.${index}.1, 192.0.2.10` });
      expect(response.json()).toEqual({ ip: "192.0.2.10" });
    }
    expect((await lookup(app, { "x-forwarded-for": "8.8.8.8, 192.0.2.10" })).status).toBe(503);
    // A different real peer has its own bucket.
    expect((await lookup(app, { "x-forwarded-for": "8.8.8.8, 192.0.2.11" })).status).toBe(201);
  });

  it("counts per-IP failures and refuses further attempts past the failure bucket", async () => {
    const app = await boot();
    const post = () =>
      app.request("POST", "/artifact/a1/password", {
        shareHost: true,
        origin: app.config.ARTIFACT_ORIGIN,
      });
    for (let index = 0; index < 20; index += 1) {
      expect((await post()).status).toBe(201);
    }
    const refused = await post();
    expect(refused.status).toBe(503);
    expect(refused.json()).toMatchObject({ error: { code: "rate.limited" } });
  });

  it("skips WebSocket and other non-HTTP contexts", async () => {
    const reflector = new Reflector();
    const guard = new IpThrottlerGuard(
      ipThrottlerOptions(reflector),
      new ClockThrottlerStorage(new FakeClock()),
      reflector,
    );
    await guard.onModuleInit();
    const context = {
      getType: () => "ws",
      getHandler: () => () => undefined,
      getClass: () => LimitsProbeController,
      switchToHttp: () => {
        throw new Error("a WebSocket context has no HTTP request");
      },
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

describe("client addresses and bucket keys", () => {
  it("unmaps IPv4-mapped IPv6 and groups IPv6 clients by /64", () => {
    const request = (ip: string | undefined) => ({ ip, socket: {} }) as unknown as Request;
    expect(clientIp(request("::ffff:203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(request("not-an-ip"))).toBeNull();
    expect(clientIp(request(undefined))).toBeNull();
    expect(ipBucketKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucketKey("2001:db8:1:2:aaaa::1")).toBe("2001:0db8:0001:0002::/64");
    expect(ipBucketKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:0db8:0001:0002::/64");
    expect(ipBucketKey("::1")).toBe("0000:0000:0000:0000::/64");
    expect(ipBucketKey("::ffff:192.0.2.1")).toBe("0000:0000:0000:0000::/64");
    expect(ipBucketKey(null)).toBe("unknown");
  });

  it("bounds memory and blocks for the block period after a breach", async () => {
    const clock = new FakeClock();
    const counters = new FixedWindowCounters({ clock, maxKeys: 3 });
    for (const key of ["a", "b", "c", "d"]) counters.hit(key, 1, 1000, 5000);
    expect(counters.size).toBe(3);
    expect(counters.hit("d", 1, 1000, 5000)).toMatchObject({
      blocked: true,
      blockRemainingMs: 5000,
    });
    await clock.advance(1000);
    expect(counters.hit("d", 1, 1000, 5000).blocked).toBe(true);
    await clock.advance(4000);
    expect(counters.hit("d", 1, 1000, 5000)).toMatchObject({ blocked: false, hits: 1 });
  });
});

describe("durable D1 counters (§5.8)", () => {
  const policy = { limit: 3, windowMs: 60_000, lockoutMs: 15 * 60_000 };
  const key = { scope: "vault.unlock_user", subject: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" };

  it("counts attempts, locks out past the limit and never extends a live lockout", async () => {
    const app = await boot();
    const counters = app.inject<DurableCounterService>(DurableCounterService);
    const now = app.clock.now();
    expect(await counters.hit(key, policy, now)).toMatchObject({ count: 1, allowed: true });
    expect(await counters.hit(key, policy, now + 1)).toMatchObject({ count: 2, allowed: true });
    expect(await counters.peek(key, policy, now + 2)).toMatchObject({ allowed: true });
    expect(await counters.hit(key, policy, now + 2)).toMatchObject({ count: 3, allowed: true });
    expect(await counters.peek(key, policy, now + 3)).toMatchObject({ allowed: false });
    const locked = await counters.hit(key, policy, now + 3);
    expect(locked).toMatchObject({
      count: 4,
      allowed: false,
      lockedUntil: now + 3 + policy.lockoutMs,
    });
    const during = await counters.hit(key, policy, now + 60_000);
    expect(during).toMatchObject({
      count: 4,
      allowed: false,
      lockedUntil: now + 3 + policy.lockoutMs,
    });
    const after = await counters.hit(key, policy, now + 3 + policy.lockoutMs);
    expect(after).toMatchObject({ count: 1, allowed: true, lockedUntil: null });
  });

  it("starts a new window after the window passes without a lockout", async () => {
    const app = await boot();
    const counters = app.inject<DurableCounterService>(DurableCounterService);
    const noLockout = { limit: 1, windowMs: 1000 };
    const now = app.clock.now();
    await counters.hit(key, noLockout, now);
    expect(await counters.hit(key, noLockout, now + 1)).toMatchObject({ count: 2, allowed: false });
    expect(await counters.hit(key, noLockout, now + 1000)).toMatchObject({
      count: 1,
      allowed: true,
    });
    await counters.reset(key);
    expect(await counters.peek(key, noLockout, now + 1000)).toMatchObject({
      count: 0,
      allowed: true,
    });
  });

  it("survives a process restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "symplist-counter-restart-"));
    try {
      const first = await bootTestApp({ imports: [LimitsProbeModule], dataDir });
      const now = first.clock.now();
      const counters = first.inject<DurableCounterService>(DurableCounterService);
      for (let index = 0; index < 4; index += 1) await counters.hit(key, policy, now + index);
      await first.close();

      const restarted = await bootTestApp({ imports: [LimitsProbeModule], dataDir });
      try {
        const state = await restarted
          .inject<DurableCounterService>(DurableCounterService)
          .peek(key, policy, now + 10);
        expect(state).toMatchObject({ count: 4, allowed: false });
      } finally {
        await restarted.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects raw addresses as scopes and oversized subjects", async () => {
    const app = await boot();
    const counters = app.inject<DurableCounterService>(DurableCounterService);
    expect(() =>
      counters.hitStatements({ scope: "Vault Unlock", subject: "x" }, policy, 1),
    ).toThrow(TypeError);
    expect(() =>
      counters.hitStatements({ scope: "vault.unlock", subject: "x".repeat(129) }, policy, 1),
    ).toThrow(TypeError);
    expect(() => counters.hitStatements(key, { limit: 0, windowMs: 1 }, 1)).toThrow(RangeError);
  });
});
