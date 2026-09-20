import { sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { SERVER_ANALYTICS } from "../../infra/analytics/analytics.providers.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function fixture(enabled = true) {
  const captureClient = vi.fn(async () => ({ status: "queued" as const }));
  const app = await bootTestApp({
    env: {
      ANALYTICS_ENABLED: String(enabled),
      POSTHOG_PROJECT_KEY: "phc_fixture_not_real",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PERSONAL_API_KEY: "phx_fixture_not_real",
      POSTHOG_PROJECT_ID: "1234",
    },
    overrides: [
      {
        token: SERVER_ANALYTICS,
        value: { enabled, captureClient, capture: vi.fn(), flush: vi.fn(), shutdown: vi.fn() },
      },
    ],
  });
  apps.push(app);
  return { app, owner: await app.createSignedInUser(), captureClient };
}
describe("consent and private event relay", () => {
  it("returns no analytics identity, persists an explicit choice and emits only after fresh stored consent", async () => {
    const { app, owner, captureClient } = await fixture();
    const settings = await app.get("/v1/analytics/consent", { session: owner.session });
    expect(settings.status).toBe(200);
    expect(settings.json()).toEqual({
      enabled: true,
      consent: { state: "unset", decidedAt: null },
    });
    const event = {
      event: "quick_chat_started",
      eventId: uuidv7(),
      properties: { entry: "button" },
    };
    expect(
      (await app.post("/v1/analytics/events", { session: owner.session, body: event })).status,
    ).toBe(204);
    expect(captureClient).not.toHaveBeenCalled();
    const consent = await app.request("PUT", "/v1/analytics/consent", {
      session: owner.session,
      body: { state: "granted" },
    });
    expect(consent.status, consent.text).toBe(200);
    const row = await app.db.first(
      sql("SELECT analytics_id FROM users WHERE id = :id", { id: owner.id }),
    );
    const identity = String(row?.analytics_id);
    expect(identity).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity).not.toBe(owner.id);
    expect(consent.text).not.toContain(identity);
    expect(consent.text).not.toContain("analytics_id");
    await app.post("/v1/analytics/events", { session: owner.session, body: event });
    expect(captureClient).toHaveBeenCalledExactlyOnceWith({
      ...event,
      subject: { consent: "granted", analyticsId: identity },
    });
    await app.request("PUT", "/v1/analytics/consent", {
      session: owner.session,
      body: { state: "denied" },
    });
    await app.post("/v1/analytics/events", {
      session: owner.session,
      body: { ...event, eventId: uuidv7() },
    });
    expect(captureClient).toHaveBeenCalledOnce();
    expect(app.logs.text()).not.toContain(identity);
  });
  it("rejects unknown properties, free text, server-owned events, injected identities, and missing CSRF", async () => {
    const { app, owner, captureClient } = await fixture();
    const event = {
      event: "quick_chat_started",
      eventId: uuidv7(),
      properties: { entry: "button" },
    };
    for (const body of [
      { ...event, analytics_id: "injected" },
      { ...event, properties: { entry: "button", url: "https://private.example" } },
      { ...event, properties: { entry: "PRIVATE-TEXT" } },
      { ...event, event: "artifact_share_created" },
    ]) {
      expect(
        (await app.post("/v1/analytics/events", { session: owner.session, body })).status,
      ).toBe(400);
    }
    expect(
      (
        await app.request("PUT", "/v1/analytics/consent", {
          session: owner.session,
          csrf: null,
          body: { state: "granted" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.post("/v1/analytics/events", { session: owner.session, csrf: null, body: event }))
        .status,
    ).toBe(403);
    expect(captureClient).not.toHaveBeenCalled();
  });
  it("disabled deployments do not solicit consent or create an identity", async () => {
    const { app, owner, captureClient } = await fixture(false);
    expect(
      (await app.get("/v1/analytics/consent", { session: owner.session })).json(),
    ).toMatchObject({ enabled: false });
    expect(
      (
        await app.request("PUT", "/v1/analytics/consent", {
          session: owner.session,
          body: { state: "granted" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.db.first(sql("SELECT analytics_id FROM users WHERE id = :id", { id: owner.id })))
        ?.analytics_id,
    ).toBeNull();
    expect(captureClient).not.toHaveBeenCalled();
  });
  it("account restriction and other-user sessions cannot change the original account's consent", async () => {
    const { app, owner } = await fixture();
    const stranger = await app.createSignedInUser();
    await app.request("PUT", "/v1/analytics/consent", {
      session: stranger.session,
      body: { state: "granted" },
    });
    expect(
      (await app.get("/v1/analytics/consent", { session: owner.session })).json(),
    ).toMatchObject({ consent: { state: "unset" } });
    await app.db.run(
      sql(
        "UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1 WHERE id = :id",
        { id: owner.id },
      ),
    );
    expect(
      (
        await app.request("PUT", "/v1/analytics/consent", {
          session: owner.session,
          body: { state: "granted" },
        })
      ).status,
    ).toBe(403);
  });
});
