import { connectionStartResultSchema, errorEnvelopeSchema } from "@symplist/contracts";
import {
  ConnectionMutations,
  ConnectionsService,
  ConnectionWebhooks,
} from "@symplist/core/connections";
import { SimonRepository } from "@symplist/core/simon";
import { sql, uuidv7 } from "@symplist/db";
import { type ConnectionLifecycleProvider, createComposioClient } from "@symplist/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp, type TestSession } from "../../../test/harness.ts";
import { CONNECTIONS_RUNTIME, type ConnectionsRuntime } from "./connections.runtime.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function boot(enabled = true, webhookSecret?: string) {
  let runtime: ConnectionsRuntime;
  const holder = {
    enabled,
    get service() {
      return runtime.service;
    },
    get mutations() {
      return runtime.mutations;
    },
    get catalogue() {
      return runtime.catalogue;
    },
    get client() {
      return runtime.client;
    },
    get webhooks() {
      return runtime.webhooks;
    },
  };
  const app = await bootTestApp({
    env: { COMPOSIO_WEBHOOK_SECRET: webhookSecret },
    overrides: [{ token: CONNECTIONS_RUNTIME, value: holder }],
  });
  apps.push(app);
  let sequence = 0;
  let callback = "";
  const provider: ConnectionLifecycleProvider = {
    authConfigs: vi.fn(async () => ({ items: [], cursor: null })),
    createAuthConfig: vi.fn(async () => "ac_1"),
    link: vi.fn(async (_owner, _config, url) => {
      callback = url;
      sequence++;
      return {
        id: `ca_${sequence}`,
        url: "https://connect.composio.dev/link?token=private_link_marker",
      };
    }),
    complete: vi.fn(async () => undefined),
    account: vi.fn(async (id) => ({ id, toolkit: "gmail", status: "ACTIVE" })),
    accounts: vi.fn(async () => ({ items: [], cursor: null })),
    revoke: vi.fn(async () => undefined),
  };
  const catalogue = {
    list: async () =>
      enabled
        ? [
            {
              slug: "gmail",
              name: "Gmail",
              description: "Read and send mail",
              auth: "managed" as const,
            },
          ]
        : [],
  };
  const sessions = {
    use: vi.fn(async () => ({
      sessionId: "session",
      update: async () => undefined,
      execute: async () => ({ data: {}, error: null, logId: "log" }),
      delete: async () => undefined,
    })),
  };
  const repository = new SimonRepository({
    db: app.db,
    keys: app.keys,
    policy: { betaAccessRequired: true },
    now: () => app.clock.now(),
    quickChatTtlHours: 24,
  });
  const service = new ConnectionsService({
    db: app.db,
    keys: app.keys,
    policy: { betaAccessRequired: true },
    now: () => app.clock.now(),
    apiOrigin: app.config.API_ORIGIN,
    provider,
    catalogue,
    sessions,
    delay: async () => undefined,
  });
  runtime = {
    ...(webhookSecret ? { client: createComposioClient("test-only-client-key") } : {}),
    webhooks: new ConnectionWebhooks(repository, sessions),
    enabled,
    service,
    catalogue,
    mutations: new ConnectionMutations({ repository, provider, sessions }),
  };
  return { app, provider, callback: () => callback };
}
async function start(app: TestApp, session: TestSession, idempotencyKey = uuidv7()) {
  return app.post("/v1/connections", {
    session,
    idempotencyKey,
    body: { toolkit: "gmail", alias: "Private work alias" },
  });
}
const code = (response: { json(): unknown }) =>
  errorEnvelopeSchema.parse(response.json()).error.code;

describe("connections HTTP boundary", () => {
  it("returns live catalogue and an empty list, with a neutral missing-configuration state", async () => {
    const { app } = await boot(false);
    const { session } = await app.createSignedInUser();
    expect((await app.get("/v1/connections", { session })).json()).toEqual({
      enabled: false,
      connections: [],
    });
    expect((await app.get("/v1/connections/catalogue", { session })).json()).toEqual({
      enabled: false,
      items: [],
    });
    expect(code(await start(app, session))).toBe("integration.unavailable");
  });

  it("issues a hosted link once and scans all local D1/object/log sinks for its one-time secret", async () => {
    const { app, provider, callback } = await boot();
    const { session } = await app.createSignedInUser();
    const request = uuidv7();
    const response = await start(app, session, request);
    expect(response.status, response.text).toBe(201);
    const first = connectionStartResultSchema.parse(response.json());
    expect(first.url).toContain("private_link_marker");
    const replay = await start(app, session, request);
    expect(replay.status, replay.text).toBe(200);
    expect(replay.json()).toMatchObject({
      attemptId: first.attemptId,
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
    expect(replay.json()).not.toHaveProperty("url");
    expect(provider.link).toHaveBeenCalledTimes(1);
    const nonce = new URL(callback()).searchParams.get("n") ?? "";
    for (const secret of ["private_link_marker", nonce, "Private work alias"]) {
      expect(await app.scanDatabaseFor(secret)).toEqual([]);
      expect(app.scanObjectsFor(secret)).toEqual([]);
      expect(app.logs.text()).not.toContain(secret);
    }
  });

  it("requires CSRF, idempotency and admission before hosted authorization", async () => {
    const { app, provider } = await boot();
    const { session } = await app.createSignedInUser();
    expect(
      code(
        await app.post("/v1/connections", {
          session,
          body: { toolkit: "gmail" },
          csrf: null,
          idempotencyKey: uuidv7(),
        }),
      ),
    ).toBe("auth.csrf_invalid");
    expect(code(await app.post("/v1/connections", { session, body: { toolkit: "gmail" } }))).toBe(
      "idempotency.key_required",
    );
    const locked = await app.createSignedInUser("locked");
    expect(code(await start(app, locked.session))).toBe("access.locked");
    expect(provider.link).not.toHaveBeenCalled();
  });

  it("confirms in the same session and redirects only to the fixed web path", async () => {
    const { app, callback, provider } = await boot();
    const { session } = await app.createSignedInUser();
    await start(app, session);
    const target = new URL(callback());
    target.searchParams.set("session_uri", "private_attestation_marker");
    target.searchParams.set("next", "https://attacker.example");
    const response = await app.get(`${target.pathname}${target.search}`, { session });
    expect(response.status, response.text).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${app.config.WEB_ORIGIN}/settings/connections?result=connected`,
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const listed = (await app.get("/v1/connections", { session })).json<{
      connections: { id: string; alias: string }[];
    }>();
    expect(listed.connections[0]?.alias).toBe("Private work alias");
    const replay = await app.get(`${target.pathname}${target.search}`, { session });
    expect(replay.headers.get("location")).toContain("result=failed");
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(app.logs.text()).not.toContain("private_attestation_marker");
    const other = await app.createSignedInUser();
    expect((await app.get("/v1/connections", { session: other.session })).json()).toEqual({
      enabled: true,
      connections: [],
    });
    const foreign = await app.request("DELETE", `/v1/connections/${listed.connections[0]?.id}`, {
      session: other.session,
      idempotencyKey: uuidv7(),
    });
    expect(foreign.status).toBe(404);
  });

  it("disconnects only through the trusted UI and replays without another provider operation", async () => {
    const { app, callback, provider } = await boot();
    const { session } = await app.createSignedInUser();
    await start(app, session);
    const target = new URL(callback());
    target.searchParams.set("session_uri", "attested");
    await app.get(`${target.pathname}${target.search}`, { session });
    const row = await app.db.first(sql("SELECT id FROM connections"));
    const id = String(row?.id);
    const request = uuidv7();
    const first = await app.request("DELETE", `/v1/connections/${id}`, {
      session,
      idempotencyKey: request,
    });
    expect(first.status, first.text).toBe(200);
    expect(first.json()).toEqual({ id, status: "disconnected" });
    const replay = await app.request("DELETE", `/v1/connections/${id}`, {
      session,
      idempotencyKey: request,
    });
    expect(replay.status).toBe(200);
    expect(provider.revoke).toHaveBeenCalledTimes(1);
  });
});

describe("raw Composio webhook", () => {
  const secret = "test-only-webhook-secret-never-live";
  function delivery(accountId: string, receipt = "msg_test", offset = 0) {
    const timestamp = String(Math.floor(Date.now() / 1000) + offset);
    const body = {
      id: receipt,
      timestamp: new Date().toISOString(),
      type: "composio.connected_account.expired",
      metadata: { ignored: "private_metadata_marker" },
      data: { id: accountId, user_id: "attacker-claimed-owner", private: "private_webhook_marker" },
    };
    const signature = createHmac("sha256", secret)
      .update(`${receipt}.${timestamp}.${JSON.stringify(body)}`)
      .digest("base64");
    return {
      body,
      headers: {
        "webhook-id": receipt,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
    };
  }

  it("verifies exact raw bytes, uses the native account mapping and deduplicates in the effect batch", async () => {
    const { app, callback } = await boot(true, secret);
    const { session } = await app.createSignedInUser();
    await start(app, session);
    const url = new URL(callback());
    url.searchParams.set("session_uri", "attested");
    await app.get(`${url.pathname}${url.search}`, { session });
    const input = delivery("ca_1");
    const first = await app.post("/webhooks/composio", input);
    expect(first.status, first.text).toBe(200);
    expect(first.json()).toEqual({ status: "accepted" });
    const second = await app.post("/webhooks/composio", input);
    expect(second.status, second.text).toBe(200);
    expect(second.json()).toEqual({ status: "duplicate" });
    expect(await app.db.first(sql("SELECT owner_id, status, generation FROM connections"))).toEqual(
      { owner_id: session.userId, status: "needs_attention", generation: 2 },
    );
    expect(await app.db.all(sql("SELECT provider, receipt_id FROM webhook_receipts"))).toEqual([
      { provider: "composio", receipt_id: "msg_test" },
    ]);
    for (const marker of ["private_webhook_marker", "private_metadata_marker"]) {
      expect(await app.scanDatabaseFor(marker)).toEqual([]);
      expect(app.scanObjectsFor(marker)).toEqual([]);
      expect(app.logs.text()).not.toContain(marker);
    }
  });

  it("rejects forged, altered and stale bodies with 400 before D1 work, without logging content", async () => {
    const { app } = await boot(true, secret);
    const batch = vi.spyOn(app.db, "batch");
    const valid = delivery("ca_1");
    const forged = await app.post("/webhooks/composio", {
      ...valid,
      headers: { ...valid.headers, "webhook-signature": "v1,bad" },
    });
    const changed = await app.post("/webhooks/composio", {
      ...valid,
      body: { ...valid.body, metadata: { changed: true } },
    });
    const old = await app.post("/webhooks/composio", delivery("ca_1", "msg_old", -301));
    expect([forged.status, changed.status, old.status]).toEqual([400, 400, 400]);
    expect(batch).not.toHaveBeenCalled();
    expect(app.logs.text()).not.toContain("private_webhook_marker");
    expect(app.logs.text()).not.toContain(secret);
  });

  it("is unprefixed and returns404 when webhook verification is not configured", async () => {
    const { app } = await boot();
    expect((await app.post("/webhooks/composio", delivery("ca_1"))).status).toBe(404);
    expect((await app.post("/v1/webhooks/composio", delivery("ca_1"))).status).toBe(404);
  });
});

import { createHmac } from "node:crypto";
