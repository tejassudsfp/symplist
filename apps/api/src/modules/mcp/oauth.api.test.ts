import { createHash } from "node:crypto";
import { oauthConsentViewSchema, oauthDecisionResultSchema } from "@symplist/contracts";
import { uuidv7 } from "@symplist/db";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { OAUTH_RUNTIME, type OAuthRuntime } from "./oauth.runtime.ts";

let app: TestApp;
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirect = "http://127.0.0.1:45678/callback";
const state = "oauth_private_state_marker";
beforeEach(async () => {
  app = await bootTestApp();
});
afterEach(async () => {
  await app.close();
});

async function register(extra: Record<string, unknown> = {}) {
  const response = await app.post("/oauth/register", {
    body: {
      client_name: "Unverified client",
      redirect_uris: [redirect],
      application_type: "native",
      ...extra,
    },
  });
  expect(response.status, response.text).toBe(201);
  return response.json() as { client_id: string };
}
function query(client: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${app.config.API_ORIGIN}/mcp`,
    scope: "tasks:read offline_access",
    state,
    ...overrides,
  }).toString();
}
async function consent() {
  const { session } = await app.createSignedInUser();
  const client = await register();
  const authorization = await app.get(`/oauth/authorize?${query(client.client_id)}`, { session });
  expect(authorization.status, authorization.text).toBe(303);
  const request =
    new URL(authorization.headers.get("location") ?? "").searchParams.get("request") ?? "";
  return { session, client, request };
}
async function authorize() {
  const context = await consent();
  const decision = await app.post(`/v1/oauth/requests/${context.request}/decision`, {
    session: context.session,
    idempotencyKey: uuidv7(),
    body: { decision: "allow", taskIds: null },
  });
  expect(decision.status, decision.text).toBe(200);
  const redirectUrl = oauthDecisionResultSchema.parse(decision.json()).redirectUrl ?? "";
  const code = new URL(redirectUrl).searchParams.get("code") ?? "";
  const exchange = {
    grant_type: "authorization_code",
    code,
    client_id: context.client.client_id,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource: `${app.config.API_ORIGIN}/mcp`,
  };
  return { ...context, redirectUrl, code, exchange };
}

describe("OAuth public and trusted consent HTTP boundaries", () => {
  it("registers only public clients with required application type and vetted redirects", async () => {
    for (const extra of [
      { application_type: undefined },
      { token_endpoint_auth_method: "client_secret_post" },
      { redirect_uris: ["http://192.168.1.1/callback"] },
      { redirect_uris: ["https://user:pass@example.test/callback"] },
    ]) {
      const result = await app.post("/oauth/register", {
        body: {
          client_name: "client",
          redirect_uris: [redirect],
          application_type: "native",
          ...extra,
        },
      });
      expect(result.status).toBe(400);
      expect(result.json()).toEqual({ error: "invalid_client_metadata" });
    }
    const client = await register();
    expect(client.client_id).toMatch(/^[a-f0-9-]{36}$/);
    const limited = await app.post("/oauth/register", { body: {} });
    expect(limited.status).toBe(503);
    expect(limited.headers.get("retry-after")).toBe("3600");
    expect(limited.json()).toMatchObject({ error: { code: "rate.limited" } });
  });
  it("never redirects bad clients, redirects, resources, PKCE or scopes", async () => {
    const client = await register();
    const invalid: Record<string, string>[] = [
      { client_id: "unknown" },
      { redirect_uri: "https://evil.test/callback" },
      { resource: "https://evil.test/mcp" },
      { code_challenge_method: "plain" },
      { scope: "vault:read" },
    ];
    for (const override of invalid) {
      const response = await app.get(`/oauth/authorize?${query(client.client_id, override)}`);
      expect(response.status, response.text).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });
  it("uses only a same-origin relative login return path and permits variable loopback ports", async () => {
    const client = await register();
    const response = await app.get(
      `/oauth/authorize?${query(client.client_id, { redirect_uri: "http://127.0.0.1:56789/callback" })}`,
    );
    expect(response.status).toBe(303);
    const login = new URL(response.headers.get("location") ?? "");
    expect(login.origin).toBe(app.config.WEB_ORIGIN);
    expect(login.pathname).toBe("/signin");
    expect(login.searchParams.get("next")).toMatch(/^\/oauth\/authorize\?/);
    expect(login.searchParams.get("next")).not.toMatch(/^\/\//);
  });
  it("requires exact consent session, CSRF and idempotency and redacts its one-time redirect", async () => {
    const { session, request } = await consent();
    const view = await app.get(`/v1/oauth/requests/${request}`, { session });
    expect(view.status, view.text).toBe(200);
    expect(oauthConsentViewSchema.parse(view.json())).toMatchObject({
      unverified: true,
      loopbackOnly: true,
      metadataHost: null,
      scopes: ["tasks:read"],
      offlineAccess: true,
    });
    const other = await app.createSignedInUser();
    expect(
      (await app.get(`/v1/oauth/requests/${request}`, { session: other.session })).status,
    ).toBe(404);
    const body = { decision: "allow", taskIds: null };
    const key = uuidv7();
    expect(
      (
        await app.post(`/v1/oauth/requests/${request}/decision`, {
          session,
          body,
          idempotencyKey: key,
          csrf: null,
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.post(`/v1/oauth/requests/${request}/decision`, { session, body })).status,
    ).toBe(400);
    const first = await app.post(`/v1/oauth/requests/${request}/decision`, {
      session,
      body,
      idempotencyKey: key,
    });
    expect(first.status, first.text).toBe(200);
    const issued = oauthDecisionResultSchema.parse(first.json());
    const url = new URL(issued.redirectUrl ?? "");
    expect(url.searchParams.get("iss")).toBe(app.config.API_ORIGIN);
    expect(url.searchParams.get("state")).toBe(state);
    const replay = await app.post(`/v1/oauth/requests/${request}/decision`, {
      session,
      body,
      idempotencyKey: key,
    });
    expect(replay.json()).toEqual({
      requestId: request,
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
    for (const secret of [url.href, url.searchParams.get("code") ?? "", state]) {
      expect(await app.scanDatabaseFor(secret)).toEqual([]);
      expect(app.scanObjectsFor(secret)).toEqual([]);
      expect(app.logs.text()).not.toContain(secret);
    }
  });
  it("denial preserves issuer/state and emits no token", async () => {
    const { session, request } = await consent();
    const response = await app.post(`/v1/oauth/requests/${request}/decision`, {
      session,
      idempotencyKey: uuidv7(),
      body: { decision: "deny" },
    });
    const url = new URL(oauthDecisionResultSchema.parse(response.json()).redirectUrl ?? "");
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("iss")).toBe(app.config.API_ORIGIN);
    expect(url.searchParams.has("code")).toBe(false);
  });
  it("issues exact 15-minute JWTs and scans all durable sinks for access and refresh secrets", async () => {
    const context = await authorize();
    const response = await app.post("/oauth/token", { body: context.exchange });
    expect(response.status, response.text).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const issued = response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(issued.expires_in).toBe(900);
    expect(decodeProtectedHeader(issued.access_token)).toEqual({
      alg: "HS256",
      typ: "at+jwt",
      kid: "1",
    });
    const jwt = decodeJwt(issued.access_token);
    expect(jwt).toMatchObject({
      iss: app.config.API_ORIGIN,
      aud: `${app.config.API_ORIGIN}/mcp`,
      client_id: context.client.client_id,
      scope: "tasks:read",
    });
    expect((jwt.exp ?? 0) - (jwt.iat ?? 0)).toBe(900);
    for (const secret of [issued.access_token, issued.refresh_token, context.code]) {
      expect(await app.scanDatabaseFor(secret)).toEqual([]);
      expect(app.scanObjectsFor(secret)).toEqual([]);
      expect(app.logs.text()).not.toContain(secret);
    }
  });
  it("rejects missing resource, wrong PKCE and broadened scope without consuming a code", async () => {
    const context = await authorize();
    for (const extra of [
      { resource: undefined },
      { code_verifier: "x".repeat(43) },
      { scope: "tasks:write" },
    ]) {
      const response = await app.post("/oauth/token", { body: { ...context.exchange, ...extra } });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
    expect((await app.post("/oauth/token", { body: context.exchange })).status).toBe(200);
    const replay = await app.post("/oauth/token", { body: context.exchange });
    expect(replay.json()).toEqual({ error: "invalid_grant" });
  });
  it("rotates refresh tokens and makes reuse revoke even the newest access token", async () => {
    const context = await authorize();
    const first = (await app.post("/oauth/token", { body: context.exchange })).json() as {
      refresh_token: string;
    };
    const body = {
      grant_type: "refresh_token",
      client_id: context.client.client_id,
      resource: context.exchange.resource,
      refresh_token: first.refresh_token,
    };
    const rotated = await app.post("/oauth/token", { body });
    expect(rotated.status, rotated.text).toBe(200);
    const latest = rotated.json() as { access_token: string; refresh_token: string };
    expect(latest.refresh_token).not.toBe(first.refresh_token);
    expect((await app.post("/oauth/token", { body })).status).toBe(400);
    await expect(
      app.inject<OAuthRuntime>(OAUTH_RUNTIME).accessTokens.verifyAccessToken(latest.access_token),
    ).rejects.toThrow("Invalid or expired access token");
  });
  it("accepts flat form token requests and revokes a refresh token without app cookies", async () => {
    const context = await authorize();
    const response = await fetch(`${app.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(context.exchange),
    });
    expect(response.status).toBe(200);
    const issued = (await response.json()) as { access_token: string; refresh_token: string };
    expect(
      (
        await app.post("/oauth/revoke", {
          body: { client_id: context.client.client_id, token: issued.refresh_token },
        })
      ).status,
    ).toBe(200);
    await expect(
      app.inject<OAuthRuntime>(OAUTH_RUNTIME).accessTokens.verifyAccessToken(issued.access_token),
    ).rejects.toThrow("Invalid or expired access token");
    expect(
      (
        await app.post("/oauth/revoke", {
          body: { client_id: context.client.client_id, token: "unknown" },
        })
      ).status,
    ).toBe(200);
  });
});
