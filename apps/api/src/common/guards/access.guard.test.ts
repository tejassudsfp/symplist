import type { D1AccessService } from "@symplist/core/access";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootTestApp,
  type TestApp,
  type TestResponse,
  type TestUserState,
  testApiEnv,
} from "../../../test/harness.ts";
import { AccessLevelsProbeModule } from "../../../test/probes/access.probe.ts";
import { ACCESS_CACHE_TTL_MS } from "../../infra/cache/session-cache.ts";
import { ACCESS_SERVICE } from "../access/access.providers.ts";
import {
  REALTIME_ACCESS_NOTIFIER,
  type RealtimeAccessNotifier,
  RUN_CANCELLER,
  type RunCanceller,
} from "../seams.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function boot(options: Parameters<typeof bootTestApp>[0] = {}): Promise<TestApp> {
  const app = await bootTestApp({ imports: [AccessLevelsProbeModule], ...options });
  apps.push(app);
  return app;
}

const errorCode = (response: TestResponse) =>
  response.json<{ error: { code: string } }>().error.code;

describe("@Access levels (§5.4)", () => {
  it.each<[TestUserState, number, string | null, number, string | null]>([
    ["admitted", 200, null, 403, "access.admin_required"],
    ["admin", 200, null, 200, null],
    ["unverified", 403, "access.unverified", 403, "access.unverified"],
    ["locked", 403, "access.locked", 403, "access.locked"],
    ["relocked", 403, "access.relocked", 403, "access.relocked"],
    ["suspended", 403, "access.suspended", 403, "access.suspended"],
  ])(
    "%s: admitted %i %s, admin %i %s",
    async (state, admittedStatus, admittedCode, adminStatus, adminCode) => {
      const app = await boot();
      const { id, session } = await app.createSignedInUser(state);
      const identity = await app.get("/v1/levels/identity", { session });
      expect(identity.status).toBe(200);
      expect(identity.json()).toEqual({ userId: id, sessionId: session.sessionId });

      const admitted = await app.get("/v1/levels/admitted", { session });
      expect(admitted.status).toBe(admittedStatus);
      if (admittedCode) expect(errorCode(admitted)).toBe(admittedCode);
      const admin = await app.get("/v1/levels/admin", { session });
      expect(admin.status).toBe(adminStatus);
      if (adminCode) expect(errorCode(admin)).toBe(adminCode);
    },
  );

  it("admits locked accounts when BETA_ACCESS_REQUIRED=false, but never relocked or suspended ones", async () => {
    const app = await boot({ env: { BETA_ACCESS_REQUIRED: "false" } });
    const locked = await app.createSignedInUser("locked");
    const relocked = await app.createSignedInUser("relocked");
    const suspended = await app.createSignedInUser("suspended");
    expect((await app.get("/v1/levels/admitted", { session: locked.session })).status).toBe(200);
    expect(errorCode(await app.get("/v1/levels/admitted", { session: relocked.session }))).toBe(
      "access.relocked",
    );
    expect(errorCode(await app.get("/v1/levels/admitted", { session: suspended.session }))).toBe(
      "access.suspended",
    );
  });

  it("returns the same 401 for missing, malformed, forged, expired, revoked and deleting sessions", async () => {
    const app = await boot();
    const expired = await app.createSignedInUser();
    const revoked = await app.createSignedInUser();
    const deleting = await app.createSignedInUser();
    await app.sessions.revoke({ userId: revoked.id, sessionId: revoked.session.sessionId });
    await app.db.run(
      sql(
        `UPDATE users SET deletion_state = 'deleting', deletion_requested_at = :now WHERE id = :id`,
        {
          now: int(app.clock.now()),
          id: deleting.id,
        },
      ),
    );
    await app.clock.advance(30 * 24 * 60 * 60 * 1000);
    const bodies = new Set<string>();
    const cookies = [
      undefined,
      `${app.sessionCookieName}=not-a-token`,
      `${app.sessionCookieName}=${Buffer.alloc(32, 1).toString("base64url")}`,
      expired.session.cookie,
      revoked.session.cookie,
    ];
    for (const cookie of cookies) {
      const response = await app.get("/v1/levels/identity", { headers: cookie ? { cookie } : {} });
      expect(response.status).toBe(401);
      const body = response.json<{ error: { code: string; message: string } }>();
      bodies.add(JSON.stringify({ code: body.error.code, message: body.error.message }));
    }
    expect([...bodies]).toEqual([
      JSON.stringify({ code: "auth.session_required", message: "Sign in to continue" }),
    ]);
  });

  it("refuses an account being deleted even at identity level", async () => {
    const app = await boot();
    const user = await app.createSignedInUser();
    await app.db.run(
      sql(
        `UPDATE users SET deletion_state = 'deleting', deletion_requested_at = 1 WHERE id = :id`,
        { id: user.id },
      ),
    );
    const response = await app.get("/v1/levels/identity", { session: user.session });
    expect(errorCode(response)).toBe("auth.session_required");
  });

  it("never reaches D1 for a malformed session cookie and caches unknown tokens", async () => {
    const app = await boot();
    const batch = vi.spyOn(app.db, "batch");
    await app.get("/v1/levels/identity", {
      headers: { cookie: `${app.sessionCookieName}=%00bad` },
    });
    expect(batch).not.toHaveBeenCalled();
    const forged = `${app.sessionCookieName}=${Buffer.alloc(32, 9).toString("base64url")}`;
    await app.get("/v1/levels/identity", { headers: { cookie: forged } });
    await app.get("/v1/levels/identity", { headers: { cookie: forged } });
    expect(batch).toHaveBeenCalledTimes(1);
    batch.mockRestore();
  });

  it("identifies each user by their own session only", async () => {
    const app = await boot();
    const alice = await app.createSignedInUser();
    const bob = await app.createSignedInUser();
    expect((await app.get("/v1/levels/identity", { session: alice.session })).json()).toMatchObject(
      {
        userId: alice.id,
      },
    );
    const mixed = await app.post("/v1/levels/sensitive", {
      session: alice.session,
      csrf: bob.session.csrf,
    });
    expect(errorCode(mixed)).toBe("auth.csrf_invalid");
  });

  it("resolves sessions from a raw Cookie header for WebSocket upgrades", async () => {
    const app = await boot();
    const user = await app.createSignedInUser();
    const sessions = app.sessions;
    const token = sessions.tokenFromCookieHeader(`theme=paper; ${user.session.cookie}; other=1`);
    expect(token).toBe(user.session.token);
    expect((await sessions.resolveToken(token, { fresh: false }))?.session.userId).toBe(user.id);
    expect(sessions.tokenFromCookieHeader("sym_session=not-a-token")).toBeNull();
    expect(sessions.tokenFromCookieHeader([`a=1`, user.session.cookie])).toBe(user.session.token);
    expect(sessions.tokenFromCookieHeader(undefined)).toBeNull();
    expect(await sessions.resolveToken("forged", { fresh: true })).toBeNull();
  });
});

describe("access caches and relock propagation (§3.3, §5.5)", () => {
  it("serves cached access for at most 10 seconds, while fresh routes read D1 at once", async () => {
    const app = await boot();
    const user = await app.createSignedInUser();
    expect((await app.get("/v1/levels/admitted", { session: user.session })).status).toBe(200);

    // Another instance relocks the account directly in D1: this process has no local invalidation.
    await app.db.run(
      sql(
        `UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1 WHERE id = :id`,
        { id: user.id },
      ),
    );
    expect((await app.get("/v1/levels/admitted", { session: user.session })).status).toBe(200);
    const fresh = await app.post("/v1/levels/sensitive", { session: user.session });
    expect(errorCode(fresh)).toBe("access.relocked");

    await app.clock.advance(ACCESS_CACHE_TTL_MS);
    expect(errorCode(await app.get("/v1/levels/admitted", { session: user.session }))).toBe(
      "access.relocked",
    );
  });

  it("evicts local caches on restriction and runs the realtime and executor effects", async () => {
    const realtime: RealtimeAccessNotifier = {
      accessRestricted: vi.fn(async () => undefined),
      sessionsEnded: vi.fn(async () => undefined),
    };
    const runs: RunCanceller = { cancelRestrictedRuns: vi.fn(async () => undefined) };
    const app = await boot({
      providers: [
        { provide: REALTIME_ACCESS_NOTIFIER, useValue: realtime },
        { provide: RUN_CANCELLER, useValue: runs },
      ],
    });
    const user = await app.createSignedInUser();
    expect((await app.get("/v1/levels/admitted", { session: user.session })).status).toBe(200);

    const access = app.inject<D1AccessService>(ACCESS_SERVICE);
    const outcome = await access.restrict({
      userId: user.id,
      reason: "relocked",
      writeId: uuidv7(app.clock.now()),
      now: app.clock.now(),
    });
    expect(outcome).toMatchObject({ applied: true, accessGeneration: 1 });
    expect(errorCode(await app.get("/v1/levels/admitted", { session: user.session }))).toBe(
      "access.relocked",
    );
    // Relock never ends the login session: the user can still reach identity-level routes (§5.5).
    expect((await app.get("/v1/levels/identity", { session: user.session })).status).toBe(200);
    expect(realtime.accessRestricted).toHaveBeenCalledWith({
      userId: user.id,
      reason: "relocked",
      accessGeneration: 1,
    });
    expect(runs.cancelRestrictedRuns).toHaveBeenCalledWith({
      userId: user.id,
      accessGeneration: 1,
    });
  });

  it("propagates a relock to a second instance within the cache TTL (deploy overlap)", async () => {
    const env = testApiEnv();
    const first = await boot({ env });
    const second = await boot({ env, dataDir: first.dataDir, clock: first.clock });
    const user = await first.createSignedInUser();
    expect((await second.get("/v1/levels/admitted", { session: user.session })).status).toBe(200);

    await first.inject<D1AccessService>(ACCESS_SERVICE).restrict({
      userId: user.id,
      reason: "suspended",
      writeId: uuidv7(first.clock.now()),
      now: first.clock.now(),
    });
    expect(errorCode(await first.get("/v1/levels/admitted", { session: user.session }))).toBe(
      "access.suspended",
    );
    await first.clock.advance(ACCESS_CACHE_TTL_MS);
    expect(errorCode(await second.get("/v1/levels/admitted", { session: user.session }))).toBe(
      "access.suspended",
    );
  });

  it("ends a revoked session immediately in this process and closes its sockets", async () => {
    const realtime: RealtimeAccessNotifier = {
      accessRestricted: vi.fn(async () => undefined),
      sessionsEnded: vi.fn(async () => undefined),
    };
    const app = await boot({
      providers: [{ provide: REALTIME_ACCESS_NOTIFIER, useValue: realtime }],
    });
    const user = await app.createSignedInUser();
    const second = await app.signIn(user.id);
    expect((await app.get("/v1/levels/identity", { session: user.session })).status).toBe(200);
    expect(await app.sessions.revoke({ userId: user.id, sessionId: user.session.sessionId })).toBe(
      true,
    );
    expect((await app.get("/v1/levels/identity", { session: user.session })).status).toBe(401);
    expect((await app.get("/v1/levels/identity", { session: second })).status).toBe(200);
    expect(realtime.sessionsEnded).toHaveBeenCalledWith({
      userId: user.id,
      sessionIds: [user.session.sessionId],
    });

    const all = await app.sessions.revokeAll(user.id);
    expect(all).toEqual([second.sessionId]);
    expect((await app.get("/v1/levels/identity", { session: second })).status).toBe(401);
  });

  it("records last-seen at most every five minutes without delaying requests", async () => {
    const app = await boot();
    const user = await app.createSignedInUser();
    const lastSeen = async () =>
      (
        await app.db.first(
          sql(`SELECT last_seen_at FROM auth_sessions WHERE id = :id`, {
            id: user.session.sessionId,
          }),
        )
      )?.last_seen_at;
    const created = await lastSeen();
    await app.clock.advance(60_000);
    await app.get("/v1/levels/identity", { session: user.session });
    await app.sessions.drain();
    expect(await lastSeen()).toBe(created);

    await app.clock.advance(5 * 60_000);
    await app.get("/v1/levels/identity", { session: user.session });
    await app.sessions.drain();
    expect(await lastSeen()).toBe(app.clock.now());
  });
});
