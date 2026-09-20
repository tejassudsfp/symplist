import type {
  AdminInvite,
  AdminInviteDetail,
  AdminInvitePage,
  GenerateInvitesResponse,
} from "@symplist/contracts";
import { generateInvitesResponseSchema, normalizeInviteCode } from "@symplist/contracts";
import { sql } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  errorCode,
  generateInvites,
  idempotencyKey,
  redeem,
  signUp,
} from "../../../test/access/helpers.ts";
import { bootTestApp, type TestApp, type TestSession } from "../../../test/harness.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function boot(options: Parameters<typeof bootTestApp>[0] = {}): Promise<TestApp> {
  const app = await bootTestApp(options);
  apps.push(app);
  return app;
}

const day = 24 * 60 * 60 * 1000;

function edit(
  app: TestApp,
  admin: TestSession,
  inviteId: string,
  action: "capacity" | "expiry" | "revoke",
  body: Record<string, unknown>,
  key = idempotencyKey(),
) {
  return app.post(`/v1/admin/invites/${inviteId}/${action}`, {
    session: admin,
    idempotencyKey: key,
    body,
  });
}

describe("admin authorization (§5.2, §5.4)", () => {
  it("refuses every beta administration route to members, locked accounts and anonymous callers", async () => {
    const app = await boot();
    const member = await app.createSignedInUser("admitted");
    const locked = await app.createSignedInUser("locked");
    const someId = "0192f0a0-0000-7000-8000-000000000123";
    const routes: [string, string, unknown?][] = [
      ["GET", "/v1/admin/invites"],
      ["GET", `/v1/admin/invites/${someId}`],
      [
        "POST",
        "/v1/admin/invites",
        { mode: "independent", count: 1, maxRedemptions: 1, expiresAt: app.clock.now() + day },
      ],
      ["POST", `/v1/admin/invites/${someId}/capacity`, { maxRedemptions: 2, expectedVersion: 1 }],
      [
        "POST",
        `/v1/admin/invites/${someId}/expiry`,
        { expiresAt: app.clock.now() + day, expectedVersion: 1 },
      ],
      ["POST", `/v1/admin/invites/${someId}/revoke`, { expectedVersion: 1 }],
      ["GET", "/v1/admin/accounts"],
      ["GET", `/v1/admin/accounts/${someId}`],
      ["POST", `/v1/admin/accounts/${someId}/unlock`, { reason: "x", expectedGeneration: 0 }],
      ["POST", `/v1/admin/accounts/${someId}/relock`, { reason: "x", expectedGeneration: 0 }],
      [
        "POST",
        `/v1/admin/accounts/${someId}/restore-eligibility`,
        { reason: "x", expectedGeneration: 0 },
      ],
      [
        "POST",
        `/v1/admin/accounts/${someId}/restore-access`,
        { reason: "x", expectedGeneration: 0 },
      ],
      ["POST", `/v1/admin/campaigns/${someId}/revocation/preview`],
      [
        "POST",
        `/v1/admin/campaigns/${someId}/revocation/confirm`,
        { previewDigest: "a".repeat(64), reason: "x" },
      ],
      ["GET", "/v1/admin/activity"],
      ["GET", `/v1/admin/activity/${someId}`],
    ];
    for (const [method, path, body] of routes) {
      const options = { idempotencyKey: idempotencyKey(), ...(body === undefined ? {} : { body }) };
      expect(
        errorCode(await app.request(method, path, { ...options, session: member.session })),
        path,
      ).toBe("access.admin_required");
      expect(
        errorCode(await app.request(method, path, { ...options, session: locked.session })),
        path,
      ).toBe("access.locked");
      expect((await app.request(method, path, options)).status, path).toBe(401);
    }
    expect(await app.db.all(sql(`SELECT id FROM beta_invites`))).toEqual([]);
  });

  it("reads admin role and access fresh, so a demoted administrator is refused at once", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    expect((await app.get("/v1/admin/invites", { session: admin.session })).status).toBe(200);
    await app.db.run(sql(`UPDATE users SET role = 'member' WHERE id = :id`, { id: admin.id }));
    expect(errorCode(await app.get("/v1/admin/invites", { session: admin.session }))).toBe(
      "access.admin_required",
    );
  });
});

describe("invite generation and one-time codes (§5.4, §6.1)", () => {
  it("generates independent codes, stores only digests and hints, and never replays a code", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const key = idempotencyKey();
    const request = {
      mode: "independent",
      count: 3,
      maxRedemptions: 1,
      expiresAt: app.clock.now() + 7 * day,
      label: "Friends — September",
    };
    const response = await app.post("/v1/admin/invites", {
      session: admin.session,
      idempotencyKey: key,
      body: request,
    });
    expect(response.status, response.text).toBe(201);
    const minted = generateInvitesResponseSchema.parse(response.json()) as Extract<
      GenerateInvitesResponse,
      { secretUnavailable: false }
    >;
    expect(minted.codes).toHaveLength(3);
    expect(new Set(minted.codes).size).toBe(3);
    for (const [index, code] of minted.codes.entries()) {
      expect(code).toMatch(/^SYM(-[A-Z2-7]{4}){8}$/);
      const canonical = normalizeInviteCode(code) ?? "";
      expect(minted.invites[index]?.hint).toBe(canonical.slice(-4));
      for (const needle of [code, canonical, canonical.slice(0, 16)]) {
        expect(await app.scanDatabaseFor(needle)).toEqual([]);
        expect(app.scanObjectsFor(needle)).toEqual([]);
        expect(app.logs.text()).not.toContain(needle);
      }
    }
    expect(minted.invites.every((invite) => invite.label === "Friends — September")).toBe(true);
    expect(await app.scanDatabaseFor("Friends")).toEqual([]);

    const retry = await app.post("/v1/admin/invites", {
      session: admin.session,
      idempotencyKey: key,
      body: request,
    });
    expect(retry.status).toBe(200);
    const replayed = generateInvitesResponseSchema.parse(retry.json());
    expect(replayed).toEqual({
      campaignId: minted.campaignId,
      invites: minted.invites,
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
    for (const code of minted.codes) expect(retry.text).not.toContain(normalizeInviteCode(code));
    expect(await app.db.all(sql(`SELECT id FROM beta_invites`))).toHaveLength(3);
    expect(
      await app.db.all(sql(`SELECT id FROM beta_admin_events WHERE action = 'invite_generated'`)),
    ).toHaveLength(1);

    const mismatch = await app.post("/v1/admin/invites", {
      session: admin.session,
      idempotencyKey: key,
      body: { ...request, count: 2 },
    });
    expect(errorCode(mismatch)).toBe("idempotency.mismatch");
  });

  it("generates one shared campaign code with a cap and an optional email binding for single codes", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const shared = await generateInvites(app, admin.session, {
      mode: "shared",
      maxRedemptions: 10,
    });
    expect(shared.codes).toHaveLength(1);
    expect(shared.invites[0]).toMatchObject({ status: "active" });
    const bound = await generateInvites(app, admin.session, { boundEmail: "Friend@Example.test" });
    const detail = await app.get(`/v1/admin/invites/${bound.invites[0]?.id}`, {
      session: admin.session,
    });
    expect(detail.json<AdminInviteDetail>().invite.boundEmail).toBe("friend@example.test");
    expect(app.email.messages).toHaveLength(0);
  });

  it("validates mode, count, cap and expiry", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const base = {
      mode: "independent",
      count: 1,
      maxRedemptions: 1,
      expiresAt: app.clock.now() + day,
    };
    const invalid = [
      { ...base, mode: "shared", count: 2 },
      { ...base, count: 3, boundEmail: "a@example.test" },
      { ...base, count: 0 },
      { ...base, count: 101 },
      { ...base, maxRedemptions: 0 },
      { ...base, label: "" },
      { ...base, mode: "everyone" },
    ];
    for (const body of invalid) {
      const response = await app.post("/v1/admin/invites", {
        session: admin.session,
        idempotencyKey: idempotencyKey(),
        body,
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    for (const expiresAt of [app.clock.now() - 1, app.clock.now() + 400 * day]) {
      const response = await app.post("/v1/admin/invites", {
        session: admin.session,
        idempotencyKey: idempotencyKey(),
        body: { ...base, expiresAt },
      });
      expect(errorCode(response)).toBe("invite.expiry_invalid");
    }
    expect(await app.db.all(sql(`SELECT id FROM beta_invites`))).toEqual([]);
  });
});

describe("invite inventory (admin invites brief)", () => {
  it("lists statuses, filters, searches hints, emails and encrypted labels, and pages with a cursor", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const friends = await generateInvites(app, admin.session, {
      mode: "shared",
      maxRedemptions: 5,
      label: "Friends — September",
    });
    await app.clock.advance(1000);
    const feedback = await generateInvites(app, admin.session, {
      count: 2,
      label: "Design feedback",
    });
    await app.clock.advance(1000);
    const expiring = await generateInvites(app, admin.session, {
      expiresAt: app.clock.now() + 2 * 60_000,
    });
    await app.clock.advance(1000);
    const bound = await generateInvites(app, admin.session, { boundEmail: "sam@example.test" });
    await app.clock.advance(1000);
    const toRevoke = await generateInvites(app, admin.session);
    const revokeInvite = toRevoke.invites[0];
    await edit(app, admin.session, revokeInvite?.id ?? "", "revoke", { expectedVersion: 1 });
    const { session } = await signUp(app);
    expect((await redeem(app, session, feedback.codes[0] ?? "")).status).toBe(200);
    await app.clock.advance(3 * 60_000);

    const list = async (query: string) => {
      const response = await app.get(`/v1/admin/invites${query}`, { session: admin.session });
      expect(response.status, response.text).toBe(200);
      return response.json<AdminInvitePage>();
    };
    const all = await list("");
    const statusOf = Object.fromEntries(all.items.map((invite) => [invite.id, invite.status]));
    expect(statusOf).toEqual({
      [revokeInvite?.id ?? ""]: "revoked",
      [bound.invites[0]?.id ?? ""]: "active",
      [expiring.invites[0]?.id ?? ""]: "expired",
      [feedback.invites[0]?.id ?? ""]: "exhausted",
      [feedback.invites[1]?.id ?? ""]: "active",
      [friends.invites[0]?.id ?? ""]: "active",
    });
    // Newest first.
    expect(all.items[0]?.id).toBe(revokeInvite?.id);
    expect(all.items.at(-1)).toMatchObject({
      used: 0,
      maxRedemptions: 5,
      remaining: 5,
      label: "Friends — September",
    });
    expect((await list("?status=active")).items).toHaveLength(3);
    expect((await list("?status=exhausted")).items.map((invite) => invite.id)).toEqual([
      feedback.invites[0]?.id,
    ]);
    expect((await list("?status=expired")).items.map((invite) => invite.id)).toEqual([
      expiring.invites[0]?.id,
    ]);
    expect((await list("?status=revoked")).items.map((invite) => invite.id)).toEqual([
      revokeInvite?.id,
    ]);
    expect((await list(`?campaignId=${feedback.campaignId}`)).items).toHaveLength(2);
    expect((await list("?q=friends")).items.map((invite) => invite.id)).toEqual([
      friends.invites[0]?.id,
    ]);
    expect((await list("?q=sam%40example")).items.map((invite) => invite.id)).toEqual([
      bound.invites[0]?.id,
    ]);
    const hint = friends.invites[0]?.hint ?? "";
    expect((await list(`?q=SYM-%E2%80%A6-${hint}`)).items.map((invite) => invite.id)).toContain(
      friends.invites[0]?.id,
    );
    expect((await list("?q=nothing-matches-this")).items).toEqual([]);

    const first = await list("?limit=4");
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(`?limit=4&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((invite) => invite.id)).toEqual(
      all.items.map((invite) => invite.id),
    );
    expect(
      (await app.get("/v1/admin/invites?status=bogus", { session: admin.session })).status,
    ).toBe(400);
  });

  it("shows an invite's redemptions with verified identities and never private content", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session, {
      mode: "shared",
      maxRedemptions: 3,
    });
    const maya = await signUp(app, "maya@example.com");
    expect((await redeem(app, maya.session, codes[0] ?? "")).status).toBe(200);
    await app.request("PUT", "/v1/me/name", {
      session: maya.session,
      body: { displayName: "Maya Rao" },
    });
    const detail = await app.get(`/v1/admin/invites/${invites[0]?.id}`, { session: admin.session });
    expect(detail.status).toBe(200);
    expect(detail.json<AdminInviteDetail>()).toMatchObject({
      invite: { used: 1, remaining: 2, status: "active" },
      redemptions: [
        {
          seatNo: 1,
          userId: maya.session.userId,
          email: "maya@example.com",
          displayName: "Maya Rao",
          grant: "current",
        },
      ],
    });
    const unknown = await app.get("/v1/admin/invites/0192f0a0-0000-7000-8000-00000000ffff", {
      session: admin.session,
    });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe("not_found");
  });
});

describe("invite edits (note 04)", () => {
  it("changes the cap without going below used seats, refusing stale versions and revoked invites", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session, {
      mode: "shared",
      maxRedemptions: 5,
    });
    const inviteId = invites[0]?.id ?? "";
    for (let index = 0; index < 3; index += 1) {
      const { session } = await signUp(app);
      expect((await redeem(app, session, codes[0] ?? "")).status).toBe(200);
    }
    const key = idempotencyKey();
    const increased = await edit(
      app,
      admin.session,
      inviteId,
      "capacity",
      { maxRedemptions: 8, expectedVersion: 1 },
      key,
    );
    expect(increased.status, increased.text).toBe(200);
    expect(increased.json<AdminInvite>()).toMatchObject({
      maxRedemptions: 8,
      used: 3,
      remaining: 5,
      version: 2,
    });
    const replay = await edit(
      app,
      admin.session,
      inviteId,
      "capacity",
      { maxRedemptions: 8, expectedVersion: 1 },
      key,
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");

    const stale = await edit(app, admin.session, inviteId, "capacity", {
      maxRedemptions: 9,
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "invite.changed", details: { version: 2 } },
    });
    const below = await edit(app, admin.session, inviteId, "capacity", {
      maxRedemptions: 2,
      expectedVersion: 2,
    });
    expect(below.json()).toMatchObject({
      error: { code: "invite.capacity_below_used", details: { used: 3 } },
    });
    expect(
      (
        await edit(app, admin.session, inviteId, "capacity", {
          maxRedemptions: 3,
          expectedVersion: 2,
        })
      ).status,
    ).toBe(200);

    const events = await app.db.all(
      sql(
        `SELECT before_json, after_json FROM beta_admin_events WHERE action = 'invite_capacity_changed' ORDER BY created_at, rowid`,
      ),
    );
    expect(
      events.map((event) => [
        JSON.parse(String(event.before_json)).maxRedemptions,
        JSON.parse(String(event.after_json)).maxRedemptions,
      ]),
    ).toEqual([
      [5, 8],
      [8, 3],
    ]);

    expect(
      (await edit(app, admin.session, inviteId, "revoke", { expectedVersion: 3 })).status,
    ).toBe(200);
    expect(
      errorCode(
        await edit(app, admin.session, inviteId, "capacity", {
          maxRedemptions: 9,
          expectedVersion: 4,
        }),
      ),
    ).toBe("invite.revoked");
    expect(
      errorCode(await edit(app, admin.session, inviteId, "revoke", { expectedVersion: 4 })),
    ).toBe("invite.revoked");
    expect(
      errorCode(
        await edit(app, admin.session, "0192f0a0-0000-7000-8000-00000000ffff", "revoke", {
          expectedVersion: 1,
        }),
      ),
    ).toBe("not_found");
  });

  it("extends expiry, which reactivates an expired invite, and refuses earlier or far expiries", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session, {
      expiresAt: app.clock.now() + 2 * 60_000,
    });
    const inviteId = invites[0]?.id ?? "";
    await app.clock.advance(3 * 60_000);
    const { session } = await signUp(app);
    expect(errorCode(await redeem(app, session, codes[0] ?? ""))).toBe("invite.invalid");
    expect(
      errorCode(
        await edit(app, admin.session, inviteId, "expiry", {
          expiresAt: app.clock.now() - 1,
          expectedVersion: 1,
        }),
      ),
    ).toBe("invite.expiry_invalid");
    expect(
      errorCode(
        await edit(app, admin.session, inviteId, "expiry", {
          expiresAt: app.clock.now() + 400 * day,
          expectedVersion: 1,
        }),
      ),
    ).toBe("invite.expiry_invalid");
    const extended = await edit(app, admin.session, inviteId, "expiry", {
      expiresAt: app.clock.now() + day,
      expectedVersion: 1,
    });
    expect(extended.json<AdminInvite>()).toMatchObject({ status: "active", version: 2 });
    expect(
      errorCode(
        await edit(app, admin.session, inviteId, "expiry", {
          expiresAt: app.clock.now() + 60_000 * 5,
          expectedVersion: 2,
        }),
      ),
    ).toBe("invite.expiry_invalid");
    expect((await redeem(app, session, codes[0] ?? "")).status).toBe(200);
  });

  it("revokes future redemption without relocking accounts already admitted", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes, invites } = await generateInvites(app, admin.session, {
      mode: "shared",
      maxRedemptions: 5,
    });
    const admitted = await signUp(app);
    expect((await redeem(app, admitted.session, codes[0] ?? "")).status).toBe(200);
    const revoked = await edit(app, admin.session, invites[0]?.id ?? "", "revoke", {
      expectedVersion: 1,
    });
    expect(revoked.json<AdminInvite>()).toMatchObject({ status: "revoked" });
    const later = await signUp(app);
    expect(errorCode(await redeem(app, later.session, codes[0] ?? ""))).toBe("invite.invalid");
    expect(await app.accessState(admitted.session.userId)).toMatchObject({ betaState: "unlocked" });
    expect((await app.get("/v1/me", { session: admitted.session })).status).toBe(200);
  });
});
