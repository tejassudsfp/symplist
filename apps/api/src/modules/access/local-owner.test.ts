import { sql } from "@symplist/db";
import { describe, expect, it } from "vitest";
import { errorCode, sessionFromResponse, setCookies } from "../../../test/access/helpers.ts";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { LOCAL_OWNER_HEADER } from "./local-owner.controller.ts";

/**
 * Sign-in for a local install (`DEPLOYMENT=local`, note 18).
 *
 * Three claims, and the second and third matter more than the first:
 *
 * 1. In a local deployment the app that started the api can get the owner's session.
 * 2. In a **cloud** deployment the route does not exist. Not "is refused" — is not mounted, so there is
 *    no handler, no token comparison and nothing to get wrong by configuration.
 * 3. The session it returns is an ordinary one. Every guard, every access decision and every
 *    owner-scoped query treats it exactly as it treats a session from an OTP, because a local-mode
 *    branch inside a guard would be a cloud vulnerability one mistake away.
 */
const apps: TestApp[] = [];

async function localApp(): Promise<TestApp> {
  const app = await bootTestApp({
    env: {
      DEPLOYMENT: "local",
      BETA_ACCESS_REQUIRED: "false",
      LOCAL_OWNER_TOKEN: "symlocal_test_only_token_value",
    },
  });
  apps.push(app);
  return app;
}

const token = "symlocal_test_only_token_value";

describe("the local owner's sign-in (note 18)", () => {
  it("provisions the owner and returns an admitted, onboarded identity", async () => {
    const app = await localApp();
    const response = await app.post("/v1/auth/local", {
      headers: { [LOCAL_OWNER_HEADER]: token },
    });
    expect(response.status, response.text).toBe(200);
    expect(response.json()).toMatchObject({
      access: { onboardingStep: "done", betaState: "unlocked", deletionState: "none" },
      destination: "app",
    });
    // The cookie is the ordinary session cookie, not a variant.
    expect(setCookies(response).some((cookie) => cookie.startsWith("sym_session="))).toBe(true);
    await app.close();
  });

  it("issues a session the ordinary guards accept, with no special case anywhere", async () => {
    const app = await localApp();
    const signIn = await app.post("/v1/auth/local", {
      headers: { [LOCAL_OWNER_HEADER]: token },
    });
    // Converted to the harness's own `TestSession`, which is the point: it is indistinguishable from a
    // session an OTP produced, so every later call goes through the cloud's own path unmodified.
    const session = await sessionFromResponse(app, signIn);
    expect((await app.get("/v1/me", { session })).status).toBe(200);
    const created = await app.request("POST", "/v1/tasks", {
      session,
      idempotencyKey: "local-owner-task",
      body: { title: "A task on my own machine", collection: "now" },
    });
    expect(created.status, created.text).toBe(201);
    await app.close();
  });

  it("is idempotent across launches: one owner, a fresh session each time", async () => {
    const app = await localApp();
    const first = await app.post("/v1/auth/local", { headers: { [LOCAL_OWNER_HEADER]: token } });
    const second = await app.post("/v1/auth/local", { headers: { [LOCAL_OWNER_HEADER]: token } });
    expect(first.json<{ user: { id: string } }>().user.id).toBe(
      second.json<{ user: { id: string } }>().user.id,
    );
    const users = await app.db.first(sql("SELECT COUNT(*) AS n FROM users"));
    expect(Number(users?.n)).toBe(1);
    await app.close();
  });

  it.each([
    ["no header at all", undefined],
    ["the wrong token", "symlocal_not_the_token_value_x"],
    ["an empty token", ""],
    ["a prefix of the token", "symlocal_test_only_token_valu"],
  ])("refuses %s, because a loopback port is not a boundary", async (_label, presented) => {
    // Every other process on the machine can reach this port. "It only listens locally" is the threat,
    // not the mitigation.
    const app = await localApp();
    const response = await app.post("/v1/auth/local", {
      ...(presented === undefined ? {} : { headers: { [LOCAL_OWNER_HEADER]: presented } }),
    });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("auth.session_required");
    // Nothing was provisioned by a refused call.
    const users = await app.db.first(sql("SELECT COUNT(*) AS n FROM users"));
    expect(Number(users?.n)).toBe(0);
    await app.close();
  });

  it("answers 404 in a cloud deployment, with the right token or without one", async () => {
    // Indistinguishable from an unregistered route: a 401 would admit the route exists, and a cloud
    // deployment should not admit even that. The `LocalOwnerService` is also null there, so a mistake in
    // the deployment check still has nothing to provision an owner with.
    const app = await bootTestApp();
    apps.push(app);
    const attempts: Readonly<Record<string, string>>[] = [{}, { [LOCAL_OWNER_HEADER]: token }];
    for (const headers of attempts) {
      const response = await app.post("/v1/auth/local", { headers });
      expect(response.status).toBe(404);
    }
    await app.close();
  });
});
