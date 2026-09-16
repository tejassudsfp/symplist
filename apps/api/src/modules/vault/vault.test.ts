import { sql } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lastOtpMessage } from "../../../test/access/helpers.ts";
import { bootTestApp, type TestApp, type TestSession } from "../../../test/harness.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function boot() {
  const app = await bootTestApp();
  apps.push(app);
  return app;
}
const passphrase = "fictional vault passphrase marker";
let sequence = 0;
const key = () => `vault-intent-${String(++sequence).padStart(12, "0")}`;
async function setup(app: TestApp, session: TestSession) {
  const result = await app.post("/v1/vault/setup", {
    session,
    body: { passphrase, confirmation: passphrase },
    idempotencyKey: key(),
  });
  expect(result.status, result.text).toBe(200);
  const cookie =
    result.headers
      .getSetCookie()
      .find((c) => c.startsWith("sym_vault="))
      ?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^sym_vault=[\w-]{43}$/);
  return cookie;
}
describe("Vault app API", () => {
  it("sets host-only HttpOnly Strict cookie, never echoes token/passphrase and exact setup retry does not mint again", async () => {
    const app = await boot();
    const user = await app.createSignedInUser("admitted");
    const intent = key();
    const result = await app.post("/v1/vault/setup", {
      session: user.session,
      body: { passphrase, confirmation: passphrase },
      idempotencyKey: intent,
    });
    expect(result.status, result.text).toBe(200);
    const cookie = result.headers.getSetCookie().find((c) => c.startsWith("sym_vault=")) ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    expect(result.text).not.toContain(passphrase);
    expect(app.logs.text()).not.toContain(passphrase);
    const raw = cookie.split(";")[0]?.split("=")[1] ?? "";
    expect(raw).toHaveLength(43);
    expect(app.logs.text()).not.toContain(raw);
    const tables = await app.db.all(
      sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"),
    );
    for (const table of tables) {
      const rows = await app.db.all(sql(`SELECT * FROM ${String(table.name)}`));
      expect(JSON.stringify(rows)).not.toContain(raw);
      expect(JSON.stringify(rows)).not.toContain(passphrase);
    }
    const replay = await app.post("/v1/vault/setup", {
      session: user.session,
      body: { passphrase, confirmation: passphrase },
      idempotencyKey: intent,
    });
    expect(replay.status, replay.text).toBe(200);
    expect(replay.headers.getSetCookie()).toEqual([]);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await app.db.first(sql("SELECT COUNT(*) AS n FROM vault_sessions"))).toEqual({ n: 1 });
  });
  it.each(["missing origin", "hostile origin", "missing csrf"])(
    "refuses %s before D1 work",
    async (which) => {
      const app = await boot();
      const user = await app.createSignedInUser("admitted");
      const batch = vi.spyOn(app.db, "batch");
      batch.mockClear();
      const response = await app.post("/v1/vault/setup", {
        session: user.session,
        body: { passphrase, confirmation: passphrase },
        idempotencyKey: key(),
        ...(which === "missing origin"
          ? { origin: null }
          : which === "hostile origin"
            ? { origin: app.config.ARTIFACT_ORIGIN }
            : { csrf: null }),
      });
      expect(response.status).toBe(403);
      if (which === "missing csrf") {
        expect(batch).toHaveBeenCalledTimes(1);
        expect(
          batch.mock.calls[0]?.[0].every((statement) => statement.sql.startsWith("SELECT")),
        ).toBe(true);
      } else expect(batch).not.toHaveBeenCalled();
    },
  );
  it.each(["locked", "relocked", "suspended"] as const)("rejects %s accounts", async (state) => {
    const app = await boot();
    const user = await app.createSignedInUser(state);
    expect((await app.get("/v1/vault", { session: user.session })).status).toBe(403);
  });
  it("ordinary login and bearer tokens cannot read Vault items", async () => {
    const app = await boot();
    const user = await app.createSignedInUser("admitted");
    await setup(app, user.session);
    expect((await app.get("/v1/vault/items", { session: user.session })).status).toBe(403);
    expect(
      (await app.get("/v1/vault", { headers: { Authorization: `Bearer ${user.session.token}` } }))
        .status,
    ).toBe(401);
  });
  it("writes once, rejects stale edits, preserves draft-independent idempotency and never replays to a locked session", async () => {
    const app = await boot();
    const user = await app.createSignedInUser("admitted");
    const cookie = await setup(app, user.session);
    const intent = key();
    const body = { type: "secret", title: "Private title marker", value: "Private value marker" };
    const options = { session: user.session, headers: { cookie }, body, idempotencyKey: intent };
    const created = await app.post("/v1/vault/items", options);
    expect(created.status, created.text).toBe(201);
    const item = created.json<{ id: string; version: number }>();
    const replay = await app.post("/v1/vault/items", options);
    expect(replay.json()).toEqual(item);
    expect(await app.db.first(sql("SELECT COUNT(*) AS n FROM vault_items"))).toEqual({ n: 1 });
    const mismatch = await app.post("/v1/vault/items", {
      ...options,
      body: { ...body, value: "different" },
    });
    expect(mismatch.status, mismatch.text).toBe(422);
    const updated = await app.request("PUT", `/v1/vault/items/${item.id}`, {
      ...options,
      body: { ...body, version: 1, value: "new value" },
      idempotencyKey: key(),
    });
    expect(updated.status, updated.text).toBe(200);
    const conflictKey = key();
    const conflict = await app.request("PUT", `/v1/vault/items/${item.id}`, {
      ...options,
      body: { ...body, version: 1 },
      idempotencyKey: conflictKey,
    });
    expect(conflict.status, conflict.text).toBe(409);
    expect(
      await app.db.first(
        sql("SELECT key FROM idempotency_records WHERE key=:key", { key: conflictKey }),
      ),
    ).toBeNull();
    await app.post("/v1/vault/lock", { session: user.session, headers: { cookie } });
    expect((await app.post("/v1/vault/items", options)).status).toBe(403);
    expect(app.logs.text()).not.toContain(body.value);
    expect(app.logs.text()).not.toContain(body.title);
    expect(
      JSON.stringify(await app.db.all(sql("SELECT * FROM idempotency_records"))),
    ).not.toContain(body.value);
  });
  it("uses fresh reset OTP, commits once, sends generic security mail and preserves contents", async () => {
    const app = await boot();
    const user = await app.createSignedInUser("admitted");
    const cookie = await setup(app, user.session);
    const item = (
      await app.post("/v1/vault/items", {
        session: user.session,
        headers: { cookie },
        idempotencyKey: key(),
        body: { type: "note", title: "My note", value: "retained contents" },
      })
    ).json<{ id: string }>();
    const sent = await app.post("/v1/vault/reset/otp", { session: user.session });
    expect(sent.status, sent.text).toBe(201);
    const otp = lastOtpMessage(app, user.email, "vault_reset");
    const verified = await app.post("/v1/vault/reset/verify", {
      session: user.session,
      body: { challengeId: sent.json<{ challengeId: string }>().challengeId, code: otp.otp },
    });
    expect(verified.status, verified.text).toBe(200);
    const body = {
      authorizationId: verified.json<{ authorizationId: string }>().authorizationId,
      passphrase: "a new fictional vault key",
      confirmation: "a new fictional vault key",
    };
    const intent = key();
    const reset = await app.post("/v1/vault/reset", {
      session: user.session,
      body,
      idempotencyKey: intent,
    });
    expect(reset.status, reset.text).toBe(200);
    const replay = await app.post("/v1/vault/reset", {
      session: user.session,
      body,
      idempotencyKey: intent,
    });
    expect(replay.status, replay.text).toBe(200);
    expect(
      await app.db.first(sql("SELECT version FROM vaults WHERE owner_id=:id", { id: user.id })),
    ).toEqual({ version: 2 });
    expect(
      (await app.get(`/v1/vault/items/${item.id}`, { session: user.session, headers: { cookie } }))
        .status,
    ).toBe(403);
    const notice = app.email.messages.find((message) => message.template === "vault_reset_notice");
    expect(notice?.sender).toBe("security");
    expect(JSON.stringify(notice)).not.toContain("retained contents");
    expect(JSON.stringify(notice)).not.toContain(body.passphrase);
    expect(app.logs.text()).not.toContain(body.passphrase);
    expect(app.logs.text()).not.toContain(otp.otp);
    expect(
      JSON.stringify(await app.db.all(sql("SELECT * FROM idempotency_records"))),
    ).not.toContain(body.passphrase);
  });
});
