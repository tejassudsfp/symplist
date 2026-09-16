import type {
  AdminAccount,
  AdminAccountDetail,
  AdminAccountPage,
  AdminEventDetail,
  AdminEventPage,
  CampaignRevocationPreview,
  CampaignRevocationResult,
} from "@symplist/contracts";
import { type Statement, sql } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminAction,
  errorCode,
  generateInvites,
  idempotencyKey,
  redeem,
  signUp,
} from "../../../test/access/helpers.ts";
import { bootTestApp, type TestApp, type TestSession } from "../../../test/harness.ts";
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

async function generation(app: TestApp, userId: string): Promise<number> {
  return (await app.accessState(userId))?.accessGeneration ?? -1;
}

async function subscribed(app: TestApp, session: TestSession): Promise<WsTestClient> {
  const socket = await WsTestClient.connect(app.wsUrl, {
    origin: app.config.WEB_ORIGIN,
    cookie: session.cookie,
  });
  sockets.push(socket);
  socket.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
  await socket.waitFor((frame) => frame.t === "snapshot");
  return socket;
}

describe("account administration (§5.4)", () => {
  it("unlocks a verified locked account with an audited, encrypted reason and an admin grant", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { session } = await signUp(app);
    const socket = await subscribed(app, session);

    const response = await adminAction(app, admin.session, session.userId, "unlock", {
      reason: "Met at the September meetup",
      expectedGeneration: 0,
    });
    expect(response.status, response.text).toBe(200);
    expect(response.json<AdminAccount>()).toMatchObject({
      id: session.userId,
      betaState: "unlocked",
      grantSource: "admin",
      accessGeneration: 1,
    });
    await socket.waitFor(
      (frame) => frame.t === "ev" && JSON.stringify(frame).includes('"betaState":"unlocked"'),
    );
    expect((await app.get("/v1/me", { session })).json()).toMatchObject({
      destination: "onboarding",
    });
    expect(await app.scanDatabaseFor("September meetup")).toEqual([]);

    const detail = (
      await app.get(`/v1/admin/accounts/${session.userId}`, { session: admin.session })
    ).json<AdminAccountDetail>();
    expect(detail.grants).toMatchObject([
      {
        source: "admin",
        actorId: admin.id,
        reason: "Met at the September meetup",
        revokedAt: null,
      },
    ]);
    expect(detail.events).toMatchObject([
      { action: "account_unlocked", actor: { id: admin.id, email: admin.email }, hasReason: true },
    ]);
    const eventId = detail.events[0]?.id;
    const event = (
      await app.get(`/v1/admin/activity/${eventId}`, { session: admin.session })
    ).json<AdminEventDetail>();
    expect(event).toMatchObject({
      reason: "Met at the September meetup",
      reasonUnavailable: false,
    });
  });

  it("unlocks a pending registration without verifying its email", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const pending = await app.createUser({ state: "unverified" });
    const response = await adminAction(app, admin.session, pending.id, "unlock", {
      reason: "Pre-approved",
      expectedGeneration: 0,
    });
    expect(response.json<AdminAccount>()).toMatchObject({
      betaState: "unlocked",
      emailVerifiedAt: null,
    });
  });

  it("refuses stale generations, unavailable actions and unknown accounts", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const user = await app.createUser({ state: "locked" });
    const stale = await adminAction(app, admin.session, user.id, "unlock", {
      reason: "x",
      expectedGeneration: 3,
    });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "admin.state_changed", details: { accessGeneration: 0 } },
    });
    expect(
      errorCode(
        await adminAction(app, admin.session, user.id, "restore-access", {
          reason: "x",
          expectedGeneration: 0,
        }),
      ),
    ).toBe("admin.action_unavailable");
    expect(
      errorCode(
        await adminAction(app, admin.session, user.id, "restore-eligibility", {
          reason: "x",
          expectedGeneration: 0,
        }),
      ),
    ).toBe("admin.action_unavailable");
    expect(
      (
        await adminAction(app, admin.session, user.id, "unlock", {
          reason: "ok",
          expectedGeneration: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      errorCode(
        await adminAction(app, admin.session, user.id, "unlock", {
          reason: "x",
          expectedGeneration: 1,
        }),
      ),
    ).toBe("admin.action_unavailable");
    expect(
      errorCode(
        await adminAction(app, admin.session, "0192f0a0-0000-7000-8000-00000000ffff", "unlock", {
          reason: "x",
          expectedGeneration: 0,
        }),
      ),
    ).toBe("not_found");
    const noReason = await adminAction(app, admin.session, user.id, "relock", {
      reason: "  ",
      expectedGeneration: 1,
    });
    expect(noReason.status).toBe(400);
    expect(await app.db.all(sql(`SELECT id FROM beta_admin_events`))).toHaveLength(1);
  });

  it("relocks through the restriction routine: sockets close, grants revoke, the seat stays used", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session);
    const { session } = await signUp(app);
    expect((await redeem(app, session, codes[0] ?? "")).status).toBe(200);
    const socket = await subscribed(app, session);

    const key = idempotencyKey();
    const relock = await adminAction(
      app,
      admin.session,
      session.userId,
      "relock",
      {
        reason: "Paused for review",
        expectedGeneration: await generation(app, session.userId),
      },
      key,
    );
    expect(relock.status, relock.text).toBe(200);
    expect(relock.json<AdminAccount>()).toMatchObject({
      betaState: "relocked",
      grantSource: null,
      accessGeneration: 2,
    });
    expect(await socket.closed).toMatchObject({ code: 4403 });
    const replay = await adminAction(
      app,
      admin.session,
      session.userId,
      "relock",
      {
        reason: "Paused for review",
        expectedGeneration: 1,
      },
      key,
    );
    expect(replay.headers.get("idempotency-replayed")).toBe("true");

    const me = await app.get("/v1/me", { session });
    expect(me.json()).toMatchObject({ destination: "paused", access: { betaState: "relocked" } });
    const grants = await app.db.all(
      sql(`SELECT revoked_reason FROM beta_access_grants WHERE user_id = :u`, {
        u: session.userId,
      }),
    );
    expect(grants).toEqual([{ revoked_reason: "relocked" }]);
    const detail = (
      await app.get(`/v1/admin/invites/${invites[0]?.id}`, { session: admin.session })
    ).json<{ invite: { used: number } }>();
    expect(detail.invite.used).toBe(1);
    expect(
      await app.db.all(
        sql(`SELECT action FROM beta_admin_events WHERE action = 'access_relocked'`),
      ),
    ).toHaveLength(1);
  });

  it("restores access with a new grant and never revives the revoked one", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes } = await generateInvites(app, admin.session);
    const { session } = await signUp(app);
    await redeem(app, session, codes[0] ?? "");
    await adminAction(app, admin.session, session.userId, "relock", {
      reason: "Pause",
      expectedGeneration: 1,
    });
    // New sockets are refused for a short margin after a restriction (decision CZ.2).
    await app.clock.advance(61_000);
    const socket = await subscribed(app, session);
    const restored = await adminAction(app, admin.session, session.userId, "restore-access", {
      reason: "Review done",
      expectedGeneration: 2,
    });
    expect(restored.json<AdminAccount>()).toMatchObject({
      betaState: "unlocked",
      grantSource: "admin",
      accessGeneration: 3,
    });
    await socket.waitFor(
      (frame) => frame.t === "ev" && JSON.stringify(frame).includes('"betaState":"unlocked"'),
    );
    const grants = await app.db.all(
      sql(
        `SELECT source, revoked_reason FROM beta_access_grants WHERE user_id = :u ORDER BY granted_at, rowid`,
        { u: session.userId },
      ),
    );
    expect(grants).toEqual([
      { source: "invite", revoked_reason: "relocked" },
      { source: "admin", revoked_reason: null },
    ]);
    // Redeeming the old code again consumes nothing and adds no grant.
    const again = await redeem(app, session, codes[0] ?? "");
    expect(again.json()).toMatchObject({ outcome: "already_unlocked" });
    expect(
      await app.db.all(
        sql(`SELECT id FROM beta_access_grants WHERE user_id = :u`, { u: session.userId }),
      ),
    ).toHaveLength(2);
  });

  it("lists accounts by filter and email search, newest first, with decrypted names", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const pending = await app.createUser({ state: "unverified", email: "pending@example.test" });
    await app.clock.advance(1000);
    const locked = await app.createUser({ state: "locked", email: "locked@example.test" });
    await app.clock.advance(1000);
    const relocked = await app.createUser({ state: "relocked", email: "relocked@example.test" });
    await app.clock.advance(1000);
    const suspended = await app.createUser({ state: "suspended", email: "suspended@example.test" });
    await app.clock.advance(1000);
    const maya = await app.createSignedInUser("admitted");
    await app.request("PUT", "/v1/me/name", {
      session: maya.session,
      body: { displayName: "Maya Rao" },
    });

    const list = async (query: string) =>
      (
        await app.get(`/v1/admin/accounts${query}`, { session: admin.session })
      ).json<AdminAccountPage>();
    expect((await list("?filter=pending")).items.map((account) => account.id)).toEqual([
      pending.id,
    ]);
    expect((await list("?filter=locked")).items.map((account) => account.id)).toEqual([locked.id]);
    expect((await list("?filter=paused")).items.map((account) => account.id)).toEqual([
      suspended.id,
      relocked.id,
    ]);
    const unlocked = await list("?filter=unlocked");
    expect(unlocked.items.map((account) => account.id)).toEqual([maya.id, admin.id]);
    expect(unlocked.items[0]?.displayName).toBe("Maya Rao");
    expect((await list("?q=LOCKED%40")).items.map((account) => account.id)).toEqual([
      relocked.id,
      locked.id,
    ]);
    expect((await list("?q=%25")).items).toEqual([]);
    const page = await list("?limit=2");
    expect(page.items).toHaveLength(2);
    const next = await list(`?limit=2&cursor=${page.nextCursor}`);
    expect(page.items.map((account) => account.id)).toEqual([maya.id, suspended.id]);
    expect(next.items.map((account) => account.id)).toEqual([relocked.id, locked.id]);
  });
});

describe("campaign revocation (§5.5)", () => {
  it("previews the campaign's admitted accounts and revokes them in bounded batches with one event each", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const campaign = await generateInvites(app, admin.session, {
      mode: "shared",
      maxRedemptions: 20,
      label: "Friends — September",
    });
    const other = await generateInvites(app, admin.session, { mode: "shared", maxRedemptions: 5 });
    const members = [];
    for (let index = 0; index < 7; index += 1) {
      const member = await signUp(app);
      expect((await redeem(app, member.session, campaign.codes[0] ?? "")).status).toBe(200);
      members.push(member);
    }
    const bystander = await signUp(app);
    await redeem(app, bystander.session, other.codes[0] ?? "");

    const preview = await app.post(
      `/v1/admin/campaigns/${campaign.campaignId}/revocation/preview`,
      { session: admin.session },
    );
    expect(preview.status, preview.text).toBe(200);
    const body = preview.json<CampaignRevocationPreview>();
    expect(body.label).toBe("Friends — September");
    expect(body.accounts.map((account) => account.id).sort()).toEqual(
      members.map((member) => member.session.userId).sort(),
    );

    // Membership changes after the preview: the confirmation is refused.
    const late = await signUp(app);
    await redeem(app, late.session, campaign.codes[0] ?? "");
    const stale = await app.post(`/v1/admin/campaigns/${campaign.campaignId}/revocation/confirm`, {
      session: admin.session,
      idempotencyKey: idempotencyKey(),
      body: { previewDigest: body.previewDigest, reason: "Campaign closed" },
    });
    expect(errorCode(stale)).toBe("admin.preview_stale");
    expect(await app.accessState(late.session.userId)).toMatchObject({ betaState: "unlocked" });

    const fresh = (
      await app.post(`/v1/admin/campaigns/${campaign.campaignId}/revocation/preview`, {
        session: admin.session,
      })
    ).json<CampaignRevocationPreview>();
    const batch = vi.spyOn(app.db, "batch");
    const confirm = await app.post(
      `/v1/admin/campaigns/${campaign.campaignId}/revocation/confirm`,
      {
        session: admin.session,
        idempotencyKey: idempotencyKey(),
        body: { previewDigest: fresh.previewDigest, reason: "Campaign closed" },
      },
    );
    expect(confirm.status, confirm.text).toBe(200);
    expect(confirm.json<CampaignRevocationResult>()).toEqual({
      campaignId: campaign.campaignId,
      revoked: 8,
      unchanged: 0,
    });
    const restrictionBatches = batch.mock.calls
      .map(
        (call) =>
          (call[0] as readonly Statement[]).filter((statement) =>
            statement.sql.startsWith("UPDATE users SET beta_state = 'relocked'"),
          ).length,
      )
      .filter((count) => count > 0);
    expect(restrictionBatches).toEqual([5, 3]);
    batch.mockRestore();

    for (const member of [...members, late]) {
      expect(await app.accessState(member.session.userId)).toMatchObject({ betaState: "relocked" });
    }
    expect(await app.accessState(bystander.session.userId)).toMatchObject({
      betaState: "unlocked",
    });
    const revokedGrants = await app.db.all(
      sql(`SELECT revoked_reason FROM beta_access_grants WHERE revoked_at IS NOT NULL`),
    );
    expect(revokedGrants).toHaveLength(8);
    expect(revokedGrants.every((grant) => grant.revoked_reason === "campaign_revoked")).toBe(true);
    const events = (
      await app.get(
        `/v1/admin/activity?action=campaign_access_revoked&campaignId=${campaign.campaignId}`,
        { session: admin.session },
      )
    ).json<AdminEventPage>();
    expect(events.items).toHaveLength(8);
    expect(
      errorCode(
        await app.post(
          `/v1/admin/campaigns/0192f0a0-0000-7000-8000-00000000ffff/revocation/preview`,
          { session: admin.session },
        ),
      ),
    ).toBe("not_found");
  });
});

describe("access activity (admin activity brief)", () => {
  it("lists immutable events newest first with filters, and hides reasons once the account key is shredded", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session, {
      mode: "shared",
      maxRedemptions: 5,
      label: "Friends — September",
    });
    await app.clock.advance(1000);
    const maya = await signUp(app, "maya@example.com");
    await redeem(app, maya.session, codes[0] ?? "");
    await app.clock.advance(1000);
    await app.post(`/v1/admin/invites/${invites[0]?.id}/capacity`, {
      session: admin.session,
      idempotencyKey: idempotencyKey(),
      body: { maxRedemptions: 8, expectedVersion: 1 },
    });
    await app.clock.advance(1000);
    await adminAction(app, admin.session, maya.session.userId, "relock", {
      reason: "Paused",
      expectedGeneration: 1,
    });

    const list = async (query: string) =>
      (
        await app.get(`/v1/admin/activity${query}`, { session: admin.session })
      ).json<AdminEventPage>();
    const all = await list("");
    expect(all.items.map((event) => event.action)).toEqual([
      "access_relocked",
      "invite_capacity_changed",
      "invite_redeemed",
      "invite_generated",
    ]);
    expect(all.items[1]).toMatchObject({
      actor: { kind: "admin", email: admin.email },
      target: { kind: "invite", label: invites[0]?.hint },
      before: { maxRedemptions: 5 },
      after: { maxRedemptions: 8 },
    });
    // "Maya redeemed Friends — September", then "Tejas increased capacity from 5 to 8".
    expect(all.items[2]).toMatchObject({
      action: "invite_redeemed",
      actor: { kind: "user", email: "maya@example.com" },
      campaign: { label: "Friends — September" },
    });
    expect(all.items[1]?.campaign?.label).toBe("Friends — September");
    expect(all.items[0]?.campaign).toBeNull();
    expect(JSON.stringify(all)).not.toContain(codes[0] ?? "x");
    expect((await list("?action=invite_redeemed")).items).toHaveLength(1);
    expect(
      (await list(`?accountId=${maya.session.userId}`)).items.map((event) => event.action),
    ).toEqual(["access_relocked", "invite_redeemed"]);
    expect((await list(`?inviteId=${invites[0]?.id}`)).items).toHaveLength(2);
    expect((await list(`?from=${app.clock.now() - 1500}`)).items).toHaveLength(2);
    expect((await list("?limit=3")).nextCursor).not.toBeNull();
    expect(
      (await app.get("/v1/admin/activity?from=yesterday", { session: admin.session })).status,
    ).toBe(400);

    const relockEvent = all.items[0];
    expect(
      (await app.get(`/v1/admin/activity/${relockEvent?.id}`, { session: admin.session })).json(),
    ).toMatchObject({ reason: "Paused" });
    // No edit or delete exists for audit events.
    expect(
      (
        await app.request("DELETE", `/v1/admin/activity/${relockEvent?.id}`, {
          session: admin.session,
        })
      ).status,
    ).toBe(404);

    await app.db.run(
      sql(`DELETE FROM account_keys WHERE owner_id = :u`, { u: maya.session.userId }),
    );
    const shredded = (
      await app.get(`/v1/admin/activity/${relockEvent?.id}`, { session: admin.session })
    ).json<AdminEventDetail>();
    expect(shredded).toMatchObject({ reason: null, reasonUnavailable: true });
  });
});
