import type { MeResponse, RedeemInviteResponse } from "@symplist/contracts";
import { sql } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminAction,
  errorCode,
  generateInvites,
  idempotencyKey,
  redeem,
  signUp,
} from "../../../test/access/helpers.ts";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { WsTestClient } from "../../../test/ws-client.ts";

const apps: TestApp[] = [];
const sockets: WsTestClient[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
});

async function boot(options: Parameters<typeof bootTestApp>[0] = {}): Promise<TestApp> {
  const app = await bootTestApp(options);
  apps.push(app);
  return app;
}

async function seats(app: TestApp, inviteId: string): Promise<number> {
  const row = await app.db.first(
    sql(`SELECT COUNT(*) AS used FROM beta_redemptions WHERE invite_id = :invite`, {
      invite: inviteId,
    }),
  );
  return Number(row?.used ?? 0);
}

describe("invite redemption over HTTP (§5.4)", () => {
  it("unlocks a verified locked account, takes it into onboarding and notifies its identity socket", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { session } = await signUp(app);
    const socket = await WsTestClient.connect(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: session.cookie,
    });
    sockets.push(socket);
    socket.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
    await socket.waitFor((frame) => frame.t === "snapshot");

    const { codes, invites } = await generateInvites(app, admin.session);
    const code = codes[0] ?? "";
    const response = await redeem(app, session, code);
    expect(response.status, response.text).toBe(200);
    const body = response.json<RedeemInviteResponse>();
    expect(body.outcome).toBe("unlocked");
    expect(body.me).toMatchObject({
      access: { betaState: "unlocked", onboardingStep: "name", accessGeneration: 1 },
      destination: "onboarding",
    });
    const changed = await socket.waitFor(
      (frame) => frame.t === "ev" && (frame as { type?: string }).type === "access.changed",
    );
    expect(changed).toMatchObject({ data: { accessState: { betaState: "unlocked" } } });

    const grants = await app.db.all(
      sql(`SELECT source, campaign_id, revoked_at FROM beta_access_grants WHERE user_id = :user`, {
        user: session.userId,
      }),
    );
    expect(grants).toEqual([
      { source: "invite", campaign_id: expect.any(String), revoked_at: null },
    ]);
    const events = await app.db.all(
      sql(
        `SELECT actor_id, action, target_id FROM beta_admin_events WHERE action = 'invite_redeemed'`,
      ),
    );
    expect(events).toEqual([
      { actor_id: session.userId, action: "invite_redeemed", target_id: invites[0]?.id },
    ]);
    // Now admitted: admin routes answer admin_required, not locked.
    expect(errorCode(await app.get("/v1/admin/invites", { session }))).toBe(
      "access.admin_required",
    );
  });

  it("normalizes casing, spaces, separators and the prefix before digesting", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes } = await generateInvites(app, admin.session, { count: 3 });
    const variants = [
      (code: string) => code.toLowerCase(),
      (code: string) => code.replace(/^SYM-/, "").replaceAll("-", " "),
      (code: string) => ` ${code.replace(/^SYM-/, "sym").replaceAll("-", "")}\n`,
    ];
    for (const [index, variant] of variants.entries()) {
      const { session } = await signUp(app);
      const response = await redeem(app, session, variant(codes[index] ?? ""));
      expect(response.status, response.text).toBe(200);
    }
  });

  it("returns the same generic invite.invalid for unknown, expired, revoked, exhausted and bound codes", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const expiring = await generateInvites(app, admin.session, {
      expiresAt: app.clock.now() + 2 * 60_000,
    });
    const revoked = await generateInvites(app, admin.session);
    const exhausted = await generateInvites(app, admin.session);
    const bound = await generateInvites(app, admin.session, { boundEmail: "someone@example.test" });
    const revokedInvite = revoked.invites[0];
    expect(
      (
        await app.post(`/v1/admin/invites/${revokedInvite?.id}/revoke`, {
          session: admin.session,
          idempotencyKey: idempotencyKey(),
          body: { expectedVersion: revokedInvite?.version },
        })
      ).status,
    ).toBe(200);
    const first = await signUp(app);
    expect((await redeem(app, first.session, exhausted.codes[0] ?? "")).status).toBe(200);
    await app.clock.advance(3 * 60_000);

    const { session } = await signUp(app);
    const attempts = [
      "SYM-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH",
      "not a code",
      expiring.codes[0] ?? "",
      revoked.codes[0] ?? "",
      exhausted.codes[0] ?? "",
      bound.codes[0] ?? "",
    ];
    const bodies = new Set<string>();
    for (const code of attempts) {
      const response = await redeem(app, session, code);
      expect(response.status).toBe(422);
      const { error } = response.json<{ error: { code: string; message: string } }>();
      bodies.add(JSON.stringify({ code: error.code, message: error.message }));
      expect(response.text).not.toContain("someone@example.test");
    }
    expect([...bodies]).toEqual([
      JSON.stringify({ code: "invite.invalid", message: "The request failed" }),
    ]);
    expect(await app.accessState(session.userId)).toMatchObject({ betaState: "locked" });
  });

  it("redeems an email-bound code only for the bound address", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const email = "friend@example.test";
    const { codes } = await generateInvites(app, admin.session, { boundEmail: email });
    const { session } = await signUp(app, email);
    expect((await redeem(app, session, codes[0] ?? "")).status).toBe(200);
  });

  it("gives the final seat to exactly one of several concurrent accounts", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session, {
      mode: "shared",
      maxRedemptions: 2,
    });
    const users = await Promise.all(Array.from({ length: 6 }, () => signUp(app)));
    const responses = await Promise.all(
      users.map(({ session }) => redeem(app, session, codes[0] ?? "")),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
    expect(responses.filter((response) => errorCode(response) === "invite.invalid")).toHaveLength(
      4,
    );
    expect(await seats(app, invites[0]?.id ?? "")).toBe(2);
    const seatNumbers = await app.db.all(
      sql(`SELECT seat_no FROM beta_redemptions ORDER BY seat_no`),
    );
    expect(seatNumbers).toEqual([{ seat_no: 1 }, { seat_no: 2 }]);
  });

  it("never consumes two seats when one account submits two different codes at once", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const first = await generateInvites(app, admin.session);
    const second = await generateInvites(app, admin.session);
    const { session } = await signUp(app);
    const responses = await Promise.all([
      redeem(app, session, first.codes[0] ?? ""),
      redeem(app, session, second.codes[0] ?? ""),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const outcomes = responses.map((response) => response.json<RedeemInviteResponse>().outcome);
    expect(outcomes).toContain("unlocked");
    for (const outcome of outcomes) expect(["unlocked", "already_unlocked"]).toContain(outcome);
    const used =
      (await seats(app, first.invites[0]?.id ?? "")) +
      (await seats(app, second.invites[0]?.id ?? ""));
    expect(used).toBe(1);
    const grants = await app.db.all(
      sql(`SELECT id FROM beta_access_grants WHERE user_id = :user`, { user: session.userId }),
    );
    expect(grants).toHaveLength(1);
  });

  it("replays an exact retry and never increments a counter again", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session, {
      mode: "shared",
      maxRedemptions: 5,
    });
    const { session } = await signUp(app);
    const key = idempotencyKey();
    const first = await redeem(app, session, codes[0] ?? "", key);
    const retry = await redeem(app, session, codes[0] ?? "", key);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotency-replayed")).toBe("true");
    expect(retry.json()).toEqual(first.json());
    const again = await redeem(app, session, codes[0] ?? "");
    expect(again.json<RedeemInviteResponse>().outcome).toBe("already_unlocked");
    expect(await seats(app, invites[0]?.id ?? "")).toBe(1);
    expect(errorCode(await redeem(app, session, "SYM-OTHER", key))).toBe("idempotency.mismatch");
  });

  it("refuses relocked and suspended accounts, so a new code never bypasses a relock", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session, {
      mode: "shared",
      maxRedemptions: 10,
    });
    const code = codes[0] ?? "";
    const { session } = await signUp(app);
    expect((await redeem(app, session, code)).status).toBe(200);
    const state = await app.accessState(session.userId);
    const relock = await adminAction(app, admin.session, session.userId, "relock", {
      reason: "Paused for review",
      expectedGeneration: state?.accessGeneration ?? 0,
    });
    expect(relock.status, relock.text).toBe(200);

    const fresh = await generateInvites(app, admin.session);
    for (const attempt of [code, fresh.codes[0] ?? ""]) {
      const response = await redeem(app, session, attempt);
      expect(response.status).toBe(403);
      expect(errorCode(response)).toBe("access.relocked");
    }
    expect(await seats(app, invites[0]?.id ?? "")).toBe(1);
    expect(await seats(app, fresh.invites[0]?.id ?? "")).toBe(0);

    const suspended = await app.createSignedInUser("suspended");
    expect(errorCode(await redeem(app, suspended.session, fresh.codes[0] ?? ""))).toBe(
      "access.relocked",
    );
  });

  it("lets an account redeem again only after Restore eligibility moves its epoch", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes } = await generateInvites(app, admin.session, { count: 2 });
    const { session } = await signUp(app);
    expect((await redeem(app, session, codes[0] ?? "")).status).toBe(200);
    let state = await app.accessState(session.userId);
    await adminAction(app, admin.session, session.userId, "relock", {
      reason: "Paused",
      expectedGeneration: state?.accessGeneration ?? 0,
    });
    state = await app.accessState(session.userId);
    const restored = await adminAction(app, admin.session, session.userId, "restore-eligibility", {
      reason: "Eligible again",
      expectedGeneration: state?.accessGeneration ?? 0,
    });
    expect(restored.status, restored.text).toBe(200);
    expect(await app.accessState(session.userId)).toMatchObject({
      betaState: "locked",
      accessEpoch: 1,
    });
    const again = await redeem(app, session, codes[1] ?? "");
    expect(again.status, again.text).toBe(200);
    // The first seat was never refunded and its revoked grant was not revived.
    const grants = await app.db.all(
      sql(
        `SELECT revoked_reason FROM beta_access_grants WHERE user_id = :user ORDER BY granted_at, rowid`,
        {
          user: session.userId,
        },
      ),
    );
    expect(grants).toEqual([{ revoked_reason: "relocked" }, { revoked_reason: null }]);
  });

  it("throttles redemptions per account before claiming the idempotency key", async () => {
    const app = await boot({ env: { TRUST_PROXY_HOPS: "1" } });
    const { session } = await signUp(app);
    for (let index = 0; index < 10; index += 1) {
      const response = await app.post("/v1/access/redeem", {
        session,
        idempotencyKey: idempotencyKey(),
        body: { code: "not a code" },
        headers: { "x-forwarded-for": `198.51.100.${index + 1}` },
      });
      expect(errorCode(response)).toBe("invite.invalid");
    }
    const batch = vi.spyOn(app.db, "batch");
    const refused = await app.post("/v1/access/redeem", {
      session,
      idempotencyKey: idempotencyKey(),
      body: { code: "not a code" },
      headers: { "x-forwarded-for": "198.51.100.99" },
    });
    expect(refused.status).toBe(503);
    expect(errorCode(refused)).toBe("rate.limited");
    // Only the cached session read may have happened; no idempotency claim or redemption statement.
    for (const call of batch.mock.calls) {
      expect(call[0].map((statement) => statement.sql).join(" ")).not.toMatch(
        /idempotency_records|beta_redemptions/,
      );
    }
  });

  it("requires an Idempotency-Key and the session CSRF token", async () => {
    const app = await boot();
    const { session } = await signUp(app);
    const noKey = await app.post("/v1/access/redeem", { session, body: { code: "x" } });
    expect(errorCode(noKey)).toBe("idempotency.key_required");
    const noCsrf = await app.post("/v1/access/redeem", {
      session,
      csrf: null,
      idempotencyKey: idempotencyKey(),
      body: { code: "x" },
    });
    expect(errorCode(noCsrf)).toBe("auth.csrf_invalid");
    expect(
      (
        await app.post("/v1/access/redeem", {
          idempotencyKey: idempotencyKey(),
          body: { code: "x" },
        })
      ).status,
    ).toBe(401);
  });

  it("skips the beta gate when BETA_ACCESS_REQUIRED=false without consuming seats", async () => {
    const app = await boot({ env: { BETA_ACCESS_REQUIRED: "false" } });
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session);
    const { session, me } = await signUp(app);
    expect(me).toMatchObject({ destination: "onboarding", betaAccessRequired: false });
    const response = await redeem(app, session, codes[0] ?? "");
    expect(response.json<RedeemInviteResponse>().outcome).toBe("already_unlocked");
    expect(await seats(app, invites[0]?.id ?? "")).toBe(0);
    const relocked = await app.createSignedInUser("relocked");
    expect(
      (await app.get("/v1/me", { session: relocked.session })).json<MeResponse>().destination,
    ).toBe("paused");
  });

  it("finalizes a claimed seat whose follow-up never committed on the next request", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session);
    const { session } = await signUp(app);
    // Simulate a lost follow-up: the seat batch commits, then the next batch fails.
    const original = app.db.batch.bind(app.db);
    let failNext = false;
    const spy = vi.spyOn(app.db, "batch").mockImplementation(async (statements, options) => {
      if (
        failNext &&
        statements.some((statement) => statement.sql.includes("INSERT INTO beta_access_grants"))
      ) {
        failNext = false;
        throw new Error("simulated unknown outcome");
      }
      if (statements.some((statement) => statement.sql.includes("INSERT INTO beta_redemptions"))) {
        failNext = true;
      }
      return original(statements, options);
    });
    const failed = await redeem(app, session, codes[0] ?? "");
    expect(failed.status).toBe(500);
    spy.mockRestore();
    expect(await seats(app, invites[0]?.id ?? "")).toBe(1);
    expect(await app.accessState(session.userId)).toMatchObject({ betaState: "locked" });

    const me = await app.get("/v1/me", { session });
    expect(me.json<MeResponse>()).toMatchObject({
      access: { betaState: "unlocked" },
      destination: "onboarding",
    });
    expect(await seats(app, invites[0]?.id ?? "")).toBe(1);
  });

  it("runs the reconciler as an hourly local job that finalizes seats of accounts that never return", async () => {
    const app = await boot({ runtime: { backgroundLoops: true } });
    const admin = await app.createSignedInUser("admin");
    const { codes } = await generateInvites(app, admin.session);
    const { session } = await signUp(app);
    const original = app.db.batch.bind(app.db);
    const spy = vi.spyOn(app.db, "batch").mockImplementation(async (statements, options) => {
      if (
        statements.some((statement) => statement.sql.includes("INSERT INTO beta_access_grants"))
      ) {
        throw new Error("simulated lost follow-up");
      }
      return original(statements, options);
    });
    expect((await redeem(app, session, codes[0] ?? "")).status).toBe(500);
    spy.mockRestore();
    expect(await app.accessState(session.userId)).toMatchObject({ betaState: "locked" });

    await app.clock.advance(60 * 60_000);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await app.accessState(session.userId))?.betaState === "unlocked") break;
      await app.clock.advance(1_000);
    }
    expect(await app.accessState(session.userId)).toMatchObject({
      betaState: "unlocked",
      accessGeneration: 1,
    });
    expect(app.logs.events("access.redemptions_reconciled")).toMatchObject([
      { count: 1, admittedCount: 1 },
    ]);
    const events = await app.db.all(
      sql(`SELECT action FROM beta_admin_events WHERE action = 'invite_redeemed'`),
    );
    expect(events).toHaveLength(1);
  });
});
