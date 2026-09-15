import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EmailTransport } from "@symplist/email";
import { FakeTriggerClient } from "@symplist/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CLOCK } from "../src/common/clock.ts";
import { TRIGGER_CLIENT } from "../src/common/seams.ts";
import { EMAIL_TRANSPORT } from "../src/infra/email/email.providers.ts";
import { OBJECT_STORE } from "../src/infra/storage/storage.providers.ts";
import { bootTestApp, type TestApp, testApiEnv } from "./harness.ts";

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("api test harness", () => {
  it("boots local drivers in a temporary directory with migrations applied and removes it on close", async () => {
    app = await bootTestApp();
    const dir = app.dataDir;
    expect(existsSync(join(dir, "d1.sqlite"))).toBe(true);
    expect(await app.db.first({ sql: "SELECT COUNT(*) AS n FROM users", params: [] })).toEqual({
      n: 0,
    });
    expect(app.config.NODE_ENV).toBe("test");
    expect(app.config.DATA_DRIVER).toBe("local");
    await app.close();
    app = undefined;
    expect(existsSync(dir)).toBe(false);
  });

  it("injects the fake clock, the fake Trigger client and the capture email transport", async () => {
    const trigger = new FakeTriggerClient();
    app = await bootTestApp({ trigger });
    expect(app.inject(CLOCK)).toBe(app.clock);
    expect(app.inject(TRIGGER_CLIENT)).toBe(trigger);
    const transport = app.inject<EmailTransport>(EMAIL_TRANSPORT);
    await transport.send({
      to: "maya@example.test",
      subject: "Your code",
      html: "<p>hi</p>",
      text: "hi",
      sender: "security",
      idempotencyKey: "otp/login/challenge-1",
      template: "otp_sign_in",
    });
    expect(app.email.delivered()).toHaveLength(1);
  });

  it("creates users in every access state and signs them in with a cookie and CSRF token", async () => {
    app = await bootTestApp();
    const expectations = {
      unverified: { emailVerifiedAt: null, betaState: "locked" },
      locked: { betaState: "locked", role: "member" },
      admitted: { betaState: "unlocked", suspendedAt: null },
      relocked: { betaState: "relocked" },
      suspended: { betaState: "unlocked", suspendedAt: app.clock.now() },
      admin: { betaState: "unlocked", role: "admin" },
      deleting: { deletionState: "deleting" },
    } as const;
    for (const [state, expected] of Object.entries(expectations)) {
      const user = await app.createUser({ state: state as keyof typeof expectations });
      expect(await app.accessState(user.id), state).toMatchObject(expected);
      // An account being deleted has had its key shredded (§5.6), so it never gets one.
      if (state === "deleting") expect(await app.accountKeys.load(user.id), state).toBeNull();
      else expect(await app.accountKeys.load(user.id), state).not.toBeNull();
    }
    const { session } = await app.createSignedInUser();
    expect(session.cookie).toBe(`sym_session=${session.token}`);
    const csrf = await app.get("/v1/auth/csrf", { session });
    expect(csrf.json()).toEqual({ token: session.csrf });
    const deleting = await app.createUser({ state: "deleting" });
    await expect(app.signIn(deleting.id)).rejects.toThrow(/cannot sign in/);
  });

  it("finds planted values in D1 rows and stored objects", async () => {
    app = await bootTestApp();
    const user = await app.createUser({ email: "Planted.Marker@Example.test" });
    expect(await app.scanDatabaseFor("planted.marker@example.test")).toEqual(["users.email"]);
    await app.inject<{ put: (input: object) => Promise<unknown> }>(OBJECT_STORE).put({
      key: `u/${user.id}/probe/object.sym`,
      body: new TextEncoder().encode("object marker 42"),
    });
    expect(app.scanObjectsFor("object marker 42")).toHaveLength(1);
    expect(app.scanObjectsFor("absent marker")).toEqual([]);
  });

  it("applies environment and provider overrides", async () => {
    const env = testApiEnv({ BETA_ACCESS_REQUIRED: "false" });
    const replaced = { send: async () => ({ providerId: "override" }) } satisfies EmailTransport;
    app = await bootTestApp({ env, overrides: [{ token: EMAIL_TRANSPORT, value: replaced }] });
    expect(app.config.BETA_ACCESS_REQUIRED).toBe(false);
    expect(app.inject(EMAIL_TRANSPORT)).toBe(replaced);
  });
});
