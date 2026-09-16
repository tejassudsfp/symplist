import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp, type TestSession } from "../../../test/harness.ts";
import { RouteClassProbeModule } from "../../../test/probes/route-classes.probe.ts";

let app: TestApp;
let session: TestSession;
let other: TestSession;
const shareCookie = "sym_share_0190aaaa=share-session-token";

beforeAll(async () => {
  app = await bootTestApp({ imports: [RouteClassProbeModule] });
  session = (await app.createSignedInUser()).session;
  other = (await app.createSignedInUser()).session;
});

afterAll(async () => {
  await app.close();
});

const code = (response: { json<T>(): T }) =>
  response.json<{ error: { code: string } }>().error.code;

describe("app route class (§5.3)", () => {
  it("requires Origin equal to WEB_ORIGIN on unsafe methods, before any D1 access", async () => {
    const batch = vi.spyOn(app.db, "batch");
    for (const origin of [null, "https://evil.example", app.config.ARTIFACT_ORIGIN, "null"]) {
      const response = await app.post("/v1/probe/app", { session, origin });
      expect(response.status, String(origin)).toBe(403);
      expect(code(response)).toBe("auth.origin_forbidden");
    }
    expect(batch).not.toHaveBeenCalled();
    batch.mockRestore();
  });

  it("requires the session-bound CSRF token of the same session", async () => {
    const random = Buffer.alloc(32, 7).toString("base64url");
    for (const csrf of [null, "1", "", random, other.csrf, `${session.csrf}x`]) {
      const response = await app.post("/v1/probe/app", { session, csrf });
      expect(response.status, String(csrf)).toBe(403);
      expect(code(response)).toBe("auth.csrf_invalid");
    }
    const ok = await app.post("/v1/probe/app", { session });
    expect(ok.status).toBe(201);
  });

  it("serves the CSRF token for the session from GET /v1/auth/csrf", async () => {
    const response = await app.get("/v1/auth/csrf", { session });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ token: session.csrf });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await app.get("/v1/auth/csrf")).status).toBe(401);
  });

  it("allows safe methods without Origin and keeps only the session and Vault cookies", async () => {
    const response = await app.get("/v1/probe/app", {
      session,
      headers: { cookie: `sym_vault=v; ${shareCookie}; other=1` },
    });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      cookies: ["sym_session", "sym_vault"],
      rawCookieHeader: null,
      authorization: null,
      rawHeaderNames: [],
    });
  });

  it("never accepts bearer credentials on /v1 (§5.2)", async () => {
    const response = await app.get("/v1/probe/app", {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(401);
    expect(code(response)).toBe("auth.session_required");
    const withCookie = await app.get("/v1/probe/app", {
      session,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(withCookie.json()).toMatchObject({ authorization: null });
  });
});

describe("pre_session route class (§5.3)", () => {
  it("requires Origin and the literal X-Symplist-CSRF: 1, and reads no cookies", async () => {
    expect((await app.post("/v1/auth/probe", { origin: null, csrf: "1" })).status).toBe(403);
    const wrongOrigin = await app.post("/v1/auth/probe", {
      origin: "https://evil.example",
      csrf: "1",
    });
    expect(code(wrongOrigin)).toBe("auth.origin_forbidden");
    for (const csrf of [null, "0", session.csrf]) {
      const response = await app.post("/v1/auth/probe", { csrf });
      expect(response.status).toBe(403);
      expect(code(response)).toBe("auth.csrf_invalid");
    }
    const ok = await app.post("/v1/auth/probe", { csrf: "1", session });
    expect(ok.status).toBe(201);
    expect(ok.json()).toEqual({
      cookies: [],
      rawCookieHeader: null,
      authorization: null,
      rawHeaderNames: [],
    });
  });
});

describe("connection_callback and oauth_authorize route classes (§5.3)", () => {
  it("accepts the callback's top-level GET without Origin but only with a session", async () => {
    expect((await app.get("/v1/connections/callback/guard-probe", { session })).status).toBe(200);
    expect((await app.get("/v1/connections/callback/guard-probe")).status).toBe(401);
  });

  it("lets /oauth/authorize read only the session cookie", async () => {
    const response = await app.get("/oauth/authorize", {
      session,
      headers: { cookie: "sym_vault=v", authorization: "Bearer x" },
    });
    expect(response.json()).toEqual({
      cookies: ["sym_session"],
      rawCookieHeader: null,
      authorization: null,
      rawHeaderNames: [],
    });
  });
});

describe("share route classes and host routing (§5.3, §6, §13.2)", () => {
  it("serves share routes only on the share host and app routes only on the api host", async () => {
    expect((await app.get("/artifact/abc")).status).toBe(404);
    expect(
      (await app.post("/artifact/abc/password", { origin: app.config.ARTIFACT_ORIGIN })).status,
    ).toBe(404);
    expect((await app.get("/v1/probe/app", { session, shareHost: true })).status).toBe(404);
    expect((await app.get("/healthz", { shareHost: true })).status).toBe(404);
    expect((await app.get("/v1/auth/csrf", { session, shareHost: true })).status).toBe(404);
  });

  it("reads only share session cookies on the share host, never the app session", async () => {
    const response = await app.get("/artifact/abc", {
      shareHost: true,
      headers: { cookie: `${session.cookie}; ${shareCookie}` },
    });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      cookies: ["sym_share_0190aaaa"],
      rawCookieHeader: null,
      authorization: null,
      rawHeaderNames: [],
    });
  });

  it("requires the share Origin, or Sec-Fetch-Site: same-origin when Origin is absent, for the password form", async () => {
    const post = (headers: Record<string, string>, origin: string | null) =>
      app.request("POST", "/artifact/abc/password", {
        shareHost: true,
        origin,
        headers: { cookie: session.cookie, ...headers },
      });
    const ok = await post({}, app.config.ARTIFACT_ORIGIN);
    expect(ok.status).toBe(201);
    expect(ok.json()).toMatchObject({ cookies: [] });
    expect((await post({ "sec-fetch-site": "same-origin" }, null)).status).toBe(201);
    for (const [headers, origin] of [
      [{}, null],
      [{ "sec-fetch-site": "same-site" }, null],
      [{}, app.config.WEB_ORIGIN],
      [{}, "https://evil.example"],
    ] as const) {
      const response = await post(headers, origin);
      expect(response.status).toBe(403);
      expect(code(response)).toBe("auth.origin_forbidden");
    }
  });
});

describe("credential-free route classes (§5.2, §5.3)", () => {
  it("strips cookies from oauth_public, signed and public_read routes and bearer from all but mcp", async () => {
    const headers = { cookie: session.cookie, authorization: "Bearer sym_grant_secret" };
    for (const [method, path] of [
      ["POST", "/oauth/token"],
      ["POST", "/internal/v1/probe"],
      ["GET", "/.well-known/probe"],
    ] as const) {
      const response = await app.request(method, path, { headers, origin: null });
      expect(response.json(), path).toEqual({
        cookies: [],
        rawCookieHeader: null,
        authorization: null,
        rawHeaderNames: [],
      });
    }
  });

  it("keeps bearer credentials on /mcp and refuses a present Origin that is not allowlisted", async () => {
    const headers = { cookie: session.cookie, authorization: "Bearer sym_grant_secret" };
    const ok = await app.request("POST", "/mcp", { headers, origin: null });
    expect(ok.json()).toEqual({
      cookies: [],
      rawCookieHeader: null,
      authorization: "Bearer sym_grant_secret",
      rawHeaderNames: ["authorization"],
    });
    expect(
      (await app.request("POST", "/mcp", { headers, origin: app.config.WEB_ORIGIN })).status,
    ).toBe(200);
    const evil = await app.request("POST", "/mcp", { headers, origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(code(evil)).toBe("auth.origin_forbidden");
  });
});

describe("CORS (§5.3, §6)", () => {
  it("grants credentialed CORS to WEB_ORIGIN on /v1 only", async () => {
    const preflight = await fetch(`${app.baseUrl}/v1/probe/app`, {
      method: "OPTIONS",
      headers: {
        origin: app.config.WEB_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-symplist-csrf,idempotency-key",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(app.config.WEB_ORIGIN);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "x-symplist-csrf",
    );
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "idempotency-key",
    );

    const evil = await fetch(`${app.baseUrl}/v1/probe/app`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();

    const read = await app.get("/v1/probe/app", { session, origin: app.config.WEB_ORIGIN });
    expect(read.headers.get("access-control-allow-origin")).toBe(app.config.WEB_ORIGIN);
    expect(read.headers.get("access-control-expose-headers")).toContain("Retry-After");
  });

  it("sends no CORS headers outside /v1 or on the share host", async () => {
    const origin = app.config.WEB_ORIGIN;
    for (const response of [
      await app.get("/healthz", { origin }),
      await app.request("POST", "/oauth/token", { origin }),
      await app.get("/artifact/abc", { origin, shareHost: true }),
      await app.get("/v1/probe/app", { origin, shareHost: true }),
    ]) {
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
    const preflight = await fetch(`${app.baseUrl}/oauth/token`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});
