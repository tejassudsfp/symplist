import { generateInvitesResponseSchema, normalizeInviteCode } from "@symplist/contracts";
import { sql } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  idempotencyKey,
  lastOtpMessage,
  sendLoginCode,
  sessionFromResponse,
  signupCode,
  verifyCode,
} from "./access/helpers.ts";
import { bootTestApp, type TestApp } from "./harness.ts";
import { assertSecretAbsent, issuedCookie } from "./secret-scan.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function boot() {
  const app = await bootTestApp();
  apps.push(app);
  return app;
}

describe("§6.1 access endpoint secret scans", () => {
  it.each(["independent", "shared"] as const)(
    "POST /admin/invites (%s): duplicate/replay/detail/list/activity never return issued codes",
    async (mode) => {
      const app = await boot();
      const admin = await app.createSignedInUser("admin");
      const body = {
        mode,
        count: mode === "independent" ? 3 : 1,
        maxRedemptions: 3,
        expiresAt: app.clock.now() + 86400000,
      };
      const options = { session: admin.session, body, idempotencyKey: idempotencyKey() };
      const issued = await app.post("/v1/admin/invites", options);
      expect(issued.status, issued.text).toBe(201);
      const result = generateInvitesResponseSchema.parse(issued.json());
      if (result.secretUnavailable) throw new Error("Mint did not issue codes");
      expect(result.codes).toHaveLength(body.count);
      const secrets = result.codes.flatMap((code) => [code, normalizeInviteCode(code) ?? ""]);
      await assertSecretAbsent(app, secrets);
      const responses = await Promise.all([
        app.post("/v1/admin/invites", options),
        app.post("/v1/admin/invites", options),
        app.get("/v1/admin/invites", { session: admin.session }),
        app.get("/v1/admin/activity", { session: admin.session }),
        ...result.invites.map((invite) =>
          app.get(`/v1/admin/invites/${invite.id}`, { session: admin.session }),
        ),
      ]);
      for (const response of responses) expect(response.status, response.text).toBe(200);
      for (const response of responses.slice(0, 2))
        expect(response.json()).toMatchObject({
          secretUnavailable: true,
          notice: "secret.already_issued",
        });
      expect(await assertSecretAbsent(app, secrets, responses)).toBe(1);
      expect(await app.db.first(sql("SELECT COUNT(*) AS n FROM beta_invites"))).toEqual({
        n: body.count,
      });
      const changed = await app.post("/v1/admin/invites", {
        ...options,
        body: { ...body, maxRedemptions: 4 },
      });
      expect(changed.status).toBe(422);
      await assertSecretAbsent(app, secrets, [changed]);
    },
  );
  it.each(["signup", "login"] as const)(
    "POST /auth/%s and /auth/otp/verify: OTP consumption and session cookies are never replayed or persisted raw",
    async (purpose) => {
      const app = await boot();
      const email =
        purpose === "signup"
          ? "new-secret-scan@example.test"
          : (await app.createSignedInUser()).email;
      const challenge =
        purpose === "signup" ? await signupCode(app, email) : await sendLoginCode(app, email);
      const otp = lastOtpMessage(app, email, purpose).otp ?? "";
      expect(otp).toMatch(/^\d{6}$/);
      const first = await verifyCode(app, challenge.challengeId, otp);
      expect(first.status, first.text).toBe(200);
      const { token } = issuedCookie(first, app.sessionCookieName);
      expect(first.text).not.toContain(token);
      expect(first.text).not.toContain(otp);
      const session = await sessionFromResponse(app, first);
      const duplicate = await verifyCode(app, challenge.challengeId, otp);
      expect(duplicate.status).toBe(410);
      expect(duplicate.json()).toMatchObject({ error: { code: "otp.expired" } });
      expect(duplicate.headers.getSetCookie()).toEqual([]);
      const me = await app.get("/v1/me", { session });
      expect(me.status).toBe(200);
      await assertSecretAbsent(app, [otp, token], [duplicate, me]);
    },
  );
  it("account deletion OTP/verify never exposes or retains the consumed email code", async () => {
    const app = await boot();
    const owner = await app.createSignedInUser();
    const sent = await app.post("/v1/account/deletion/otp", { session: owner.session });
    expect(sent.status, sent.text).toBe(201);
    const otp = lastOtpMessage(app, owner.email, "account_delete").otp ?? "";
    const options = {
      session: owner.session,
      body: { challengeId: sent.json<{ challengeId: string }>().challengeId, code: otp },
    };
    const verified = await app.post("/v1/account/deletion/verify", options);
    expect(verified.status, verified.text).toBe(200);
    const duplicate = await app.post("/v1/account/deletion/verify", options);
    expect(duplicate.status).toBe(410);
    expect(duplicate.json()).toMatchObject({ error: { code: "otp.expired" } });
    await assertSecretAbsent(app, [otp, owner.session.token], [sent, verified, duplicate]);
  });
});
