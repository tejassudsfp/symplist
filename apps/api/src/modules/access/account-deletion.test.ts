import type {
  AccountDeletionAuthorizationResponse,
  OtpChallengeResponse,
} from "@symplist/contracts";
import { sql } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  errorCode,
  generateInvites,
  idempotencyKey,
  lastOtpMessage,
  redeem,
  setCookies,
  signUp,
  wrongCode,
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

async function authorize(app: TestApp, session: TestSession, email: string): Promise<string> {
  const sent = await app.post("/v1/account/deletion/otp", { session });
  expect(sent.status, sent.text).toBe(201);
  const challenge = sent.json<OtpChallengeResponse>();
  expect(challenge.purpose).toBe("account_delete");
  const code = lastOtpMessage(app, email, "account_delete").otp ?? "";
  const verified = await app.post("/v1/account/deletion/verify", {
    session,
    body: { challengeId: challenge.challengeId, code },
  });
  expect(verified.status, verified.text).toBe(200);
  return verified.json<AccountDeletionAuthorizationResponse>().authorizationId;
}

describe("account deletion request (§5.6)", () => {
  it("verifies a deletion code, shreds the key, ends every session and socket, clears cookies and purges", async () => {
    const app = await boot();
    const admin = await app.createSignedInUser("admin");
    const { codes } = await generateInvites(app, admin.session, { label: "Friends" });
    const { session, email } = await signUp(app, "maya@example.com");
    expect((await redeem(app, session, codes[0] ?? "")).status).toBe(200);
    await app.request("PUT", "/v1/me/name", { session, body: { displayName: "Maya Rao" } });
    const second = await app.signIn(session.userId);
    const socket = await WsTestClient.connect(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: second.cookie,
    });
    sockets.push(socket);

    const authorizationId = await authorize(app, session, email);
    const response = await app.post("/v1/account/deletion", {
      session,
      idempotencyKey: idempotencyKey(),
      body: { authorizationId },
    });
    expect(response.status, response.text).toBe(202);
    expect(response.json()).toEqual({ status: "deleting" });
    expect(setCookies(response).some((cookie) => /^sym_session=;/.test(cookie))).toBe(true);
    expect(await socket.closed).toMatchObject({ code: 4403 });

    expect(await app.accountKeys.load(session.userId)).toBeNull();
    expect((await app.get("/v1/me", { session })).status).toBe(401);
    expect((await app.get("/v1/me", { session: second })).status).toBe(401);
    // A crypto-shredded account's invite grant is revoked in the same batch.
    const grant = await app.db.first(
      sql(`SELECT revoked_reason FROM beta_access_grants WHERE user_id = :u`, {
        u: session.userId,
      }),
    );
    expect(grant).toMatchObject({ revoked_reason: "deleted" });

    // The local executor runs the purge; its access contributor removes the grants and keeps the seat.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const done = await app.db.first(
        sql(`SELECT status FROM account_deletions WHERE user_id = :u`, { u: session.userId }),
      );
      if (done?.status === "done") break;
      await app.clock.advance(5_000);
    }
    expect(
      await app.db.first(
        sql(`SELECT status FROM account_deletions WHERE user_id = :u`, { u: session.userId }),
      ),
    ).toMatchObject({ status: "done" });
    expect(
      await app.db.all(sql(`SELECT id FROM users WHERE id = :u`, { u: session.userId })),
    ).toEqual([]);
    expect(
      await app.db.all(
        sql(`SELECT id FROM beta_access_grants WHERE user_id = :u`, { u: session.userId }),
      ),
    ).toEqual([]);
    expect(
      await app.db.all(
        sql(`SELECT id FROM beta_redemptions WHERE user_id = :u`, { u: session.userId }),
      ),
    ).toHaveLength(1);
    expect(await app.scanDatabaseFor("maya@example.com")).toEqual([]);
  });

  it("is available to locked, relocked and suspended accounts", async () => {
    const app = await boot();
    for (const state of ["locked", "relocked", "suspended"] as const) {
      const user = await app.createSignedInUser(state);
      const authorizationId = await authorize(app, user.session, user.email);
      const response = await app.post("/v1/account/deletion", {
        session: user.session,
        idempotencyKey: idempotencyKey(),
        body: { authorizationId },
      });
      expect(response.status, state).toBe(202);
    }
  });

  it("binds the code and the authorization to the requesting session and uses each once", async () => {
    const app = await boot();
    const user = await app.createSignedInUser("admitted");
    const other = await app.signIn(user.id);
    const stranger = await app.createSignedInUser("admitted");

    const sent = (
      await app.post("/v1/account/deletion/otp", { session: user.session })
    ).json<OtpChallengeResponse>();
    const code = lastOtpMessage(app, user.email, "account_delete").otp ?? "";
    for (const session of [other, stranger.session]) {
      const refused = await app.post("/v1/account/deletion/verify", {
        session,
        body: { challengeId: sent.challengeId, code },
      });
      expect(errorCode(refused)).toBe("otp.expired");
    }
    // A login challenge is never accepted as a deletion code.
    const wrong = await app.post("/v1/account/deletion/verify", {
      session: user.session,
      body: { challengeId: sent.challengeId, code: wrongCode(code) },
    });
    expect(errorCode(wrong)).toBe("otp.incorrect");
    const verified = await app.post("/v1/account/deletion/verify", {
      session: user.session,
      body: { challengeId: sent.challengeId, code },
    });
    const { authorizationId, expiresAt } = verified.json<AccountDeletionAuthorizationResponse>();
    expect(expiresAt - app.clock.now()).toBe(10 * 60_000);

    for (const session of [other, stranger.session]) {
      const refused = await app.post("/v1/account/deletion", {
        session,
        idempotencyKey: idempotencyKey(),
        body: { authorizationId },
      });
      expect(errorCode(refused)).toBe("account.deletion_unauthorized");
    }
    expect(await app.accessState(user.id)).toMatchObject({ deletionState: "none" });

    await app.clock.advance(10 * 60_000);
    const expired = await app.post("/v1/account/deletion", {
      session: user.session,
      idempotencyKey: idempotencyKey(),
      body: { authorizationId },
    });
    expect(errorCode(expired)).toBe("account.deletion_unauthorized");
    expect(await app.accountKeys.load(user.id)).not.toBeNull();
  });

  it("requires the session CSRF token and an Idempotency-Key", async () => {
    const app = await boot();
    const user = await app.createSignedInUser("admitted");
    expect(
      errorCode(await app.post("/v1/account/deletion/otp", { session: user.session, csrf: null })),
    ).toBe("auth.csrf_invalid");
    expect(
      errorCode(
        await app.post("/v1/account/deletion", {
          session: user.session,
          body: { authorizationId: "0192f0a0-0000-7000-8000-000000000001" },
        }),
      ),
    ).toBe("idempotency.key_required");
    expect(app.email.messages).toHaveLength(0);
  });
});
