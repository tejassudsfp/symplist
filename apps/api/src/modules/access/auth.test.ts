import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeResponse, OtpChallengeResponse } from "@symplist/contracts";
import { sql } from "@symplist/db";
import { EmailSendError } from "@symplist/email";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  errorCode,
  lastOtpMessage,
  sendLoginCode,
  sessionFromResponse,
  setCookies,
  signInWithCode,
  signUp,
  signupCode,
  verifyCode,
  wrongCode,
} from "../../../test/access/helpers.ts";
import { bootTestApp, type TestApp, testApiEnv } from "../../../test/harness.ts";
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

const minute = 60_000;

describe("account lookup and signup (§5.1)", () => {
  it("reports verified accounts, and treats pending registrations and unknown addresses as absent", async () => {
    const app = await boot();
    const verified = await app.createUser({ state: "locked" });
    const pending = await app.createUser({ state: "unverified" });
    const lookup = (email: string) => app.post("/v1/auth/lookup", { csrf: "1", body: { email } });

    expect((await lookup(verified.email)).json()).toEqual({ exists: true });
    expect((await lookup(` ${verified.email.toUpperCase()} `)).json()).toEqual({ exists: true });
    expect((await lookup(pending.email)).json()).toEqual({ exists: false });
    expect((await lookup("nobody@example.test")).json()).toEqual({ exists: false });
    const invalid = await lookup("not an email");
    expect(invalid.status).toBe(400);
    expect(invalid.text).not.toContain("not an email");
  });

  it("requires the pre_session class: WEB_ORIGIN and X-Symplist-CSRF: 1, before any D1 access", async () => {
    const app = await boot();
    const batch = vi.spyOn(app.db, "batch");
    const body = { email: "maya@example.com" };
    expect((await app.post("/v1/auth/lookup", { body })).status).toBe(403);
    expect((await app.post("/v1/auth/lookup", { body, csrf: "1", origin: null })).status).toBe(403);
    expect(
      (await app.post("/v1/auth/lookup", { body, csrf: "1", origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect(batch).not.toHaveBeenCalled();
  });

  it("creates a pending account only on explicit consent, idempotently, and sends a signup code", async () => {
    const app = await boot();
    const email = "maya@example.com";
    const refused = await app.post("/v1/auth/signup", { csrf: "1", body: { email } });
    expect(refused.status).toBe(400);
    expect(await app.db.all(sql(`SELECT id FROM users WHERE email = :email`, { email }))).toEqual(
      [],
    );

    const first = await signupCode(app, email);
    expect(first).toMatchObject({ purpose: "signup", codeLength: 6 });
    expect(first.expiresAt - app.clock.now()).toBe(10 * minute);
    expect(first.resendAvailableAt - app.clock.now()).toBe(minute);
    const message = lastOtpMessage(app, email, "signup");
    expect(message.sender).toBe("security");
    expect(message.subject).not.toContain(message.otp ?? "");

    await app.clock.advance(minute);
    await signupCode(app, email);
    const users = await app.db.all(
      sql(`SELECT id, email_verified_at, beta_state FROM users WHERE email = :email`, { email }),
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email_verified_at: null, beta_state: "locked" });
  });

  it("answers a signup for a verified address with auth.account_exists and sends nothing", async () => {
    const app = await boot();
    const user = await app.createUser({ state: "admitted" });
    const response = await app.post("/v1/auth/signup", {
      csrf: "1",
      body: { email: user.email, consent: true },
    });
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("auth.account_exists");
    expect(app.email.messages).toHaveLength(0);
  });

  it("refuses login codes for unknown, pending and deleting accounts", async () => {
    const app = await boot();
    const pending = await app.createUser({ state: "unverified" });
    const deleting = await app.createUser({ state: "deleting" });
    const send = (email: string) => app.post("/v1/auth/otp", { csrf: "1", body: { email } });
    expect(errorCode(await send("nobody@example.test"))).toBe("auth.account_not_found");
    expect(errorCode(await send(pending.email))).toBe("auth.account_not_found");
    expect(errorCode(await send(deleting.email))).toBe("auth.account_unavailable");
    expect(app.email.messages).toHaveLength(0);
  });
});

describe("code verification and sessions (§5.1)", () => {
  it("verifies a signup, creates the session and account key, and leaves beta access locked", async () => {
    const app = await boot();
    const email = "maya@example.com";
    const challenge = await signupCode(app, email);
    const code = lastOtpMessage(app, email, "signup").otp ?? "";
    const response = await verifyCode(app, challenge.challengeId, code);
    expect(response.status, response.text).toBe(200);
    const me = response.json<MeResponse>();
    expect(me).toMatchObject({
      user: { email, displayName: null, role: "member" },
      access: { betaState: "locked", onboardingStep: "name" },
      destination: "beta_gate",
      betaAccessRequired: true,
    });
    expect(me.access.emailVerifiedAt).toBe(app.clock.now());

    const cookies = setCookies(response);
    expect(cookies.find((cookie) => cookie.startsWith("sym_session="))).toMatch(/HttpOnly/i);
    expect(cookies.find((cookie) => cookie.startsWith("sym_hint=1"))).toBeDefined();
    const session = await sessionFromResponse(app, response);
    expect(await app.accountKeys.load(session.userId)).not.toBeNull();

    const again = await app.get("/v1/me", { session });
    expect(again.status).toBe(200);
    expect(again.json<MeResponse>().destination).toBe("beta_gate");
    // A locked account never reaches admitted routes.
    expect(errorCode(await app.get("/v1/admin/invites", { session }))).toBe("access.locked");
  });

  it("routes existing accounts by access: app, onboarding, beta gate or paused", async () => {
    const app = await boot();
    const destinations: Record<string, string> = {};
    for (const state of ["admitted", "locked", "relocked", "suspended"] as const) {
      const user = await app.createUser({ state });
      destinations[state] = (await signInWithCode(app, user.email)).me.destination;
    }
    expect(destinations).toEqual({
      admitted: "app",
      locked: "beta_gate",
      relocked: "paused",
      suspended: "paused",
    });
  });

  it("consumes a code once and refuses unknown and superseded challenges as expired", async () => {
    const app = await boot();
    const user = await app.createUser();
    const first = await sendLoginCode(app, user.email);
    const firstCode = lastOtpMessage(app, user.email, "login").otp ?? "";
    await app.clock.advance(minute);
    const second = await sendLoginCode(app, user.email);
    const secondCode = lastOtpMessage(app, user.email, "login").otp ?? "";

    expect(errorCode(await verifyCode(app, first.challengeId, firstCode))).toBe("otp.expired");
    expect((await verifyCode(app, second.challengeId, secondCode)).status).toBe(200);
    expect(errorCode(await verifyCode(app, second.challengeId, secondCode))).toBe("otp.expired");
    expect(
      errorCode(await verifyCode(app, "0192f0a0-0000-7000-8000-00000000abcd", secondCode)),
    ).toBe("otp.expired");
  });

  it("expires codes after OTP_TTL_MINUTES", async () => {
    const app = await boot();
    const user = await app.createUser();
    const challenge = await sendLoginCode(app, user.email);
    const code = lastOtpMessage(app, user.email, "login").otp ?? "";
    await app.clock.advance(10 * minute);
    expect(errorCode(await verifyCode(app, challenge.challengeId, code))).toBe("otp.expired");
  });

  it("counts attempts per challenge and refuses the right code once they are used", async () => {
    const app = await boot();
    const user = await app.createUser();
    const challenge = await sendLoginCode(app, user.email);
    const code = lastOtpMessage(app, user.email, "login").otp ?? "";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await verifyCode(app, challenge.challengeId, wrongCode(code));
      expect(response.status).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "otp.incorrect", details: { attemptsRemaining: 5 - attempt } },
      });
    }
    expect(errorCode(await verifyCode(app, challenge.challengeId, wrongCode(code)))).toBe(
      "otp.attempts_exhausted",
    );
    expect(errorCode(await verifyCode(app, challenge.challengeId, code))).toBe(
      "otp.attempts_exhausted",
    );
  });

  it("never lets concurrent guesses exceed the attempt budget of a challenge", async () => {
    const app = await boot();
    const user = await app.createUser();
    const challenge = await sendLoginCode(app, user.email);
    const code = lastOtpMessage(app, user.email, "login").otp ?? "";
    const guesses = Array.from({ length: 12 }, (_, index) =>
      String((Number(code) + index + 1) % 1_000_000).padStart(6, "0"),
    );
    const responses = await Promise.all(
      guesses.map((guess) => verifyCode(app, challenge.challengeId, guess)),
    );
    expect(responses.filter((response) => errorCode(response) === "otp.incorrect")).toHaveLength(4);
    const row = await app.db.first(
      sql(`SELECT attempts FROM otp_challenges WHERE id = :id`, { id: challenge.challengeId }),
    );
    expect(row?.attempts).toBe(5);
  });

  it("locks verification for an hour after 10 failures across challenges, and the lock survives a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "symplist-otp-restart-"));
    const env = testApiEnv();
    try {
      const first = await bootTestApp({ env, dataDir });
      const user = await first.createUser();
      let failures = 0;
      while (failures < 10) {
        const challenge = await sendLoginCode(first, user.email);
        const code = lastOtpMessage(first, user.email, "login").otp ?? "";
        for (let attempt = 0; attempt < 5 && failures < 10; attempt += 1) {
          const response = await verifyCode(first, challenge.challengeId, wrongCode(code));
          failures += 1;
          if (failures < 10)
            expect(errorCode(response)).toMatch(/^otp\.(incorrect|attempts_exhausted)$/);
          else
            expect(response.json()).toMatchObject({
              error: { code: "otp.locked", details: { retryAfter: 3600 } },
            });
        }
        await first.clock.advance(minute);
      }
      const now = first.clock.now();
      await first.close();

      const restarted = await bootTestApp({ env, dataDir });
      apps.push(restarted);
      await restarted.clock.set(now);
      const challenge = await sendLoginCode(restarted, user.email);
      const code = lastOtpMessage(restarted, user.email, "login").otp ?? "";
      const locked = await verifyCode(restarted, challenge.challengeId, code);
      expect(locked.status).toBe(429);
      expect(errorCode(locked)).toBe("otp.locked");
      // The refused attempt spent nothing and revealed nothing: after the hour the same code works.
      await restarted.clock.advance(60 * minute);
      const challengeAfter = await sendLoginCode(restarted, user.email);
      const codeAfter = lastOtpMessage(restarted, user.email, "login").otp ?? "";
      expect((await verifyCode(restarted, challengeAfter.challengeId, codeAfter)).status).toBe(200);
      // Success cleared the failure count.
      const limits = await restarted.db.all(
        sql(`SELECT failures, locked_until FROM otp_limits WHERE purpose = 'login'`),
      );
      expect(limits).toEqual([{ failures: 0, locked_until: null }]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("limits codes to one a minute, 5 an hour and 10 a day per address and purpose, durably", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "symplist-otp-send-"));
    const env = testApiEnv({ TRUST_PROXY_HOPS: "1" });
    // Each request comes from its own client address so the per-IP bucket never interferes.
    let client = 0;
    const send = (app: TestApp, email: string) => {
      client += 1;
      return app.post("/v1/auth/otp", {
        csrf: "1",
        body: { email },
        headers: { "x-forwarded-for": `198.51.100.${client % 250}` },
      });
    };
    try {
      const app = await bootTestApp({ env, dataDir });
      const user = await app.createUser();
      expect((await send(app, user.email)).status).toBe(201);
      const cooldown = await send(app, user.email);
      expect(cooldown.json()).toMatchObject({
        error: { code: "otp.cooldown", details: { retryAfter: 60 } },
      });
      for (let index = 1; index < 5; index += 1) {
        await app.clock.advance(minute);
        expect((await send(app, user.email)).status).toBe(201);
      }
      await app.clock.advance(minute);
      const hourly = await send(app, user.email);
      expect(errorCode(hourly)).toBe("otp.send_limited");
      const now = app.clock.now();
      await app.close();

      const restarted = await bootTestApp({ env, dataDir });
      apps.push(restarted);
      await restarted.clock.set(now);
      expect(errorCode(await send(restarted, user.email))).toBe("otp.send_limited");
      await restarted.clock.advance(60 * minute);
      for (let index = 0; index < 5; index += 1) {
        expect((await send(restarted, user.email)).status).toBe(201);
        await restarted.clock.advance(minute);
      }
      const daily = await send(restarted, user.email);
      expect(errorCode(daily)).toBe("otp.send_limited");
      expect(
        daily.json<{ error: { details: { retryAfter: number } } }>().error.details.retryAfter,
      ).toBeGreaterThan(3600);
      // Another purpose has its own limits.
      expect(
        (
          await restarted.post("/v1/auth/signup", {
            csrf: "1",
            body: { email: "other@example.test", consent: true },
          })
        ).status,
      ).toBe(201);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reports a failed delivery without holding the address in the cooldown", async () => {
    const app = await boot();
    const user = await app.createUser();
    app.email.failNextWith(new EmailSendError("email.rejected", "rejected", { status: 422 }));
    const failed = await app.post("/v1/auth/otp", { csrf: "1", body: { email: user.email } });
    expect(failed.status).toBe(502);
    expect(errorCode(failed)).toBe("auth.delivery_failed");
    expect(await app.db.all(sql(`SELECT id FROM otp_challenges`))).toEqual([]);
    expect((await sendLoginCode(app, user.email)).purpose).toBe("login");
  });

  it("retries a retryable delivery failure once with the same provider idempotency key", async () => {
    const app = await boot();
    const user = await app.createUser();
    app.email.failNextWith(
      new EmailSendError("email.network_error", "network", { retryable: true }),
    );
    const challenge = await sendLoginCode(app, user.email);
    expect(app.email.messages[0]?.idempotencyKey).toBe(`otp/login/${challenge.challengeId}`);
  });

  it("stores codes only as digests and never logs them", async () => {
    const app = await boot();
    const { email } = await signUp(app);
    const code = lastOtpMessage(app, email, "signup").otp ?? "";
    expect(await app.scanDatabaseFor(code)).toEqual([]);
    expect(app.logs.text()).not.toContain(code);
    expect(app.logs.text()).not.toContain(email);
  });

  it("throttles lookups per client IP and per address before D1", async () => {
    const app = await boot({ env: { TRUST_PROXY_HOPS: "1" } });
    const lookup = (email: string, ip: string) =>
      app.post("/v1/auth/lookup", {
        csrf: "1",
        body: { email },
        headers: { "x-forwarded-for": ip },
      });
    for (let index = 0; index < 10; index += 1) {
      expect((await lookup(`probe${index}@example.test`, "203.0.113.7")).status).toBe(200);
    }
    const byIp = await lookup("another@example.test", "203.0.113.7");
    expect(byIp.status).toBe(503);
    expect(errorCode(byIp)).toBe("rate.limited");

    for (let index = 0; index < 10; index += 1) {
      expect((await lookup("target@example.test", `198.51.100.${index + 1}`)).status).toBe(200);
    }
    const batch = vi.spyOn(app.db, "batch");
    const byAddress = await lookup("TARGET@example.test", "198.51.100.200");
    expect(byAddress.status).toBe(503);
    expect(byAddress.headers.get("retry-after")).not.toBeNull();
    expect(batch).not.toHaveBeenCalled();
  });

  it("signs out: revokes the session, closes its sockets with 4401 and clears the cookies", async () => {
    const app = await boot();
    const user = await app.createUser();
    const { session } = await signInWithCode(app, user.email);
    const other = await app.signIn(user.id);
    const socket = await WsTestClient.connect(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: session.cookie,
    });
    sockets.push(socket);
    const response = await app.post("/v1/auth/logout", { session });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ signedOut: true });
    const cleared = setCookies(response);
    expect(cleared.some((cookie) => /^sym_session=;/.test(cookie))).toBe(true);
    expect(cleared.some((cookie) => /^sym_hint=;/.test(cookie))).toBe(true);
    expect(await socket.closed).toMatchObject({ code: 4401 });
    expect((await app.get("/v1/me", { session })).status).toBe(401);
    expect((await app.get("/v1/me", { session: other })).status).toBe(200);
    // Logout needs the session-bound CSRF token.
    expect((await app.post("/v1/auth/logout", { session: other, csrf: null })).status).toBe(403);
  });
});

describe("the test-only OTP outbox", () => {
  it("returns the latest delivered code in NODE_ENV=test", async () => {
    const app = await boot();
    const user = await app.createUser();
    const challenge: OtpChallengeResponse = await sendLoginCode(app, user.email);
    const response = await app.post("/v1/auth/test/otp", {
      csrf: "1",
      body: { email: user.email, purpose: "login" },
    });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      challengeId: challenge.challengeId,
      code: lastOtpMessage(app, user.email, "login").otp,
      purpose: "login",
    });
  });

  it("does not exist outside NODE_ENV=test", async () => {
    const app = await boot({ env: { NODE_ENV: "development" } });
    const user = await app.createUser();
    await sendLoginCode(app, user.email);
    const response = await app.post("/v1/auth/test/otp", {
      csrf: "1",
      body: { email: user.email, purpose: "login" },
    });
    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe("not_found");
    expect(response.text).not.toContain(lastOtpMessage(app, user.email, "login").otp ?? "x");
  });
});
