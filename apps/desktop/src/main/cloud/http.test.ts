import { describe, expect, it, vi } from "vitest";
import { silentMainLog } from "../log.ts";
import { CookieJar } from "./cookie-jar.ts";
import { CloudRequestRefused, createCloudHttp, resolveApiUrl } from "./http.ts";

const API = "https://api.symplist.test";
const WEB = "https://app.symplist.test";

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Headers;
}

function client(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  jar = new CookieJar(),
) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    sent.push({ url: url.toString(), init, headers: new Headers(init.headers) });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return {
    http: createCloudHttp({ apiOrigin: API, webOrigin: WEB, jar, log: silentMainLog, fetchImpl }),
    jar,
    sent,
  };
}

function json(status: number, body: unknown, headers: readonly [string, string][] = []) {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: [["content-type", "application/json"], ...headers],
  });
  return response;
}

describe("the cloud client", () => {
  it("sends Origin as the api's own WEB_ORIGIN, which is the whole reason it runs in main", async () => {
    // RouteClassGuard.checkOrigin compares this header to config.WEB_ORIGIN by string equality, for
    // pre_session routes on every method. A Chromium renderer cannot set it; this process can.
    const { http, sent } = client(() => json(200, { exists: false }));
    await http({ method: "POST", path: "/v1/auth/lookup", headers: [], body: "{}" });
    expect(sent[0]?.headers.get("Origin")).toBe(WEB);
  });

  it("forwards the CSRF header for both classes and drops anything not on the allowlist", async () => {
    const { http, sent } = client(() => json(200, {}));
    await http({
      method: "POST",
      path: "/v1/auth/otp",
      headers: [
        ["X-Symplist-CSRF", "1"],
        ["Content-Type", "application/json"],
        ["Idempotency-Key", "0123456789abcdef"],
        ["Accept", "application/json"],
        // A renderer must not be able to choose these.
        ["Cookie", "sym_session=stolen"],
        ["Authorization", "Bearer nope"],
        ["Host", "elsewhere.test"],
        ["X-Forwarded-For", "10.0.0.1"],
      ],
      body: "{}",
    });
    const headers = sent[0]?.headers;
    expect(headers?.get("X-Symplist-CSRF")).toBe("1");
    expect(headers?.get("Idempotency-Key")).toBe("0123456789abcdef");
    expect(headers?.get("Content-Type")).toBe("application/json");
    expect(headers?.get("Authorization")).toBeNull();
    expect(headers?.get("X-Forwarded-For")).toBeNull();
    // Cookie is set from the jar, never from the caller, and the jar is empty here.
    expect(headers?.get("Cookie")).toBeNull();
  });

  it("consumes Set-Cookie into the jar and never returns it to the caller", async () => {
    const { http, jar } = client(() =>
      json(200, { destination: "app" }, [
        ["set-cookie", "__Host-sym_session=tok; Path=/; Max-Age=600; HttpOnly"],
        ["set-cookie", "sym_vault=v; Path=/; Max-Age=3600; SameSite=Strict"],
      ]),
    );
    const response = await http({
      method: "POST",
      path: "/v1/auth/otp/verify",
      headers: [],
      body: "{}",
    });
    expect(response.headers.map(([name]) => name.toLowerCase())).not.toContain("set-cookie");
    expect(jar.session()?.value).toBe("tok");
    expect(jar.header()).toContain("sym_vault=v");
  });

  it("sends the jar's cookie on the next request", async () => {
    const jar = new CookieJar();
    jar.restoreSession({ name: "sym_session", value: "tok", expiresAt: null });
    const { http, sent } = client(() => json(200, {}), jar);
    await http({ method: "GET", path: "/v1/me", headers: [], body: null });
    expect(sent[0]?.headers.get("Cookie")).toBe("sym_session=tok");
  });

  it("refuses a redirect instead of re-sending the cookie to whatever Location names", async () => {
    const { http, jar } = client(
      () =>
        new Response(null, {
          status: 302,
          headers: [
            ["location", "https://evil.test/collect"],
            ["set-cookie", "sym_session=planted; Max-Age=600"],
          ],
        }),
    );
    await expect(http({ method: "GET", path: "/v1/me", headers: [], body: null })).rejects.toThrow(
      CloudRequestRefused,
    );
    // The redirect's cookies are not consumed either.
    expect(jar.session()).toBeNull();
  });

  it("builds its own init, so the caller's credentials and redirect mode never reach undici", async () => {
    const { http, sent } = client(() => json(200, {}));
    await http({ method: "GET", path: "/v1/me", headers: [], body: null });
    expect(sent[0]?.init.redirect).toBe("manual");
    expect(sent[0]?.init.cache).toBe("no-store");
    expect(sent[0]?.init).not.toHaveProperty("credentials");
    expect(sent[0]?.init).not.toHaveProperty("mode");
  });

  it("returns only the response headers a client needs", async () => {
    const { http } = client(() =>
      json(429, { error: { code: "rate.limited" } }, [
        ["retry-after", "30"],
        ["x-request-id", "req_1"],
        ["x-powered-by", "express"],
      ]),
    );
    const response = await http({ method: "GET", path: "/v1/me", headers: [], body: null });
    expect(response.status).toBe(429);
    expect(new Headers(response.headers.map(([n, v]) => [n, v])).get("retry-after")).toBe("30");
    expect(new Headers(response.headers.map(([n, v]) => [n, v])).get("x-powered-by")).toBeNull();
  });

  it("refuses a method it was not built to send", async () => {
    const { http, sent } = client(() => json(200, {}));
    await expect(
      http({ method: "TRACE", path: "/v1/me", headers: [], body: null }),
    ).rejects.toThrow(CloudRequestRefused);
    expect(sent).toHaveLength(0);
  });

  it("refuses a path that is not on the api origin under /v1/", async () => {
    const { http, sent } = client(() => json(200, {}));
    for (const path of [
      "/oauth/token",
      "/internal/v1/relay",
      "/mcp",
      "//evil.test/v1/me",
      "/v1/../oauth/token",
      "v1/me",
      "/v1\\me",
      "https://evil.test/v1/me",
    ]) {
      await expect(http({ method: "GET", path, headers: [], body: null }), path).rejects.toThrow(
        CloudRequestRefused,
      );
    }
    expect(sent).toHaveLength(0);
  });
});

describe("resolving an api url", () => {
  it("accepts a /v1 path with a query and normalises traversal", () => {
    expect(resolveApiUrl(API, "/v1/tasks?collection=now")?.toString()).toBe(
      `${API}/v1/tasks?collection=now`,
    );
    // `/v1/a/../../oauth` normalises out of /v1/ and is therefore refused, not sent.
    expect(resolveApiUrl(API, "/v1/a/../../oauth/token")).toBeNull();
  });

  it("refuses anything that would leave the api origin", () => {
    expect(resolveApiUrl(API, "//evil.test/v1/me")).toBeNull();
    expect(resolveApiUrl(API, "https://evil.test/v1/me")).toBeNull();
    expect(resolveApiUrl(API, "/healthz")).toBeNull();
  });
});
