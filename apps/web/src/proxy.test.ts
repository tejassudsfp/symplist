// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContentSecurityPolicy, createNonce } from "./lib/security/headers.ts";
import { config, proxy, SESSION_HINT_COOKIE } from "./proxy.ts";

/** A request from a browser that holds the api's non-secret presence cookie (§5.1). */
function signedInRequest(url: string): NextRequest {
  const request = new NextRequest(url);
  request.cookies.set(SESSION_HINT_COOKIE, "1");
  return request;
}

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Content Security Policy (§10.4)", () => {
  it("sets a nonce-based policy on the response and forwards it to rendering", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.symplist.test");
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://api.symplist.test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://us.i.posthog.com");
    const response = proxy(signedInRequest("https://app.symplist.test/now"));
    const policy = response.headers.get("content-security-policy") ?? "";
    const forwarded = response.headers.get("x-middleware-request-content-security-policy");
    const nonce = response.headers.get("x-middleware-request-x-nonce") ?? "";
    expect(forwarded).toBe(policy);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
    const csp = directives(policy);
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("script-src")).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    expect(csp.get("style-src-elem")).toEqual(["'self'", `'nonce-${nonce}'`]);
    expect(csp.get("style-src-attr")).toEqual(["'unsafe-inline'"]);
    expect(csp.get("connect-src")).toEqual([
      "'self'",
      "https://api.symplist.test",
      "wss://api.symplist.test",
      "https://us.i.posthog.com",
    ]);
    expect(csp.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(csp.get("font-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("form-action")).toEqual(["'self'", "https://api.symplist.test"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy).not.toContain("unsafe-eval");
    expect(csp.get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("issues a fresh nonce for every request", () => {
    const nonces = new Set(
      Array.from({ length: 20 }, () =>
        proxy(signedInRequest("https://app.symplist.test/now")).headers.get(
          "x-middleware-request-x-nonce",
        ),
      ),
    );
    expect(nonces.size).toBe(20);
  });

  it("omits unset or invalid origins instead of widening the policy", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "javascript:alert(1)");
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "http://insecure.test");
    const policy = proxy(signedInRequest("https://app.symplist.test/")).headers.get(
      "content-security-policy",
    );
    const csp = directives(policy ?? "");
    expect(csp.get("connect-src")).toEqual(["'self'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
  });

  it("relaxes only what next dev needs in development", () => {
    const policy = buildContentSecurityPolicy({
      nonce: createNonce(),
      apiOrigin: "http://localhost:4000",
      wsOrigin: "ws://localhost:4000",
      posthogHost: null,
      development: true,
    });
    const csp = directives(policy);
    expect(csp.get("script-src")).toContain("'unsafe-eval'");
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
  });

  it.each(["", "short", "abc'; script-src *", `${"a".repeat(20)} 'unsafe-inline'`])(
    "rejects a malformed nonce %j",
    (nonce) => {
      expect(() =>
        buildContentSecurityPolicy({
          nonce,
          apiOrigin: null,
          wsOrigin: null,
          posthogHost: null,
          development: false,
        }),
      ).toThrow();
    },
  );

  it("runs on pages but not on static assets", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    expect(matcher.test("/now")).toBe(true);
    expect(matcher.test("/")).toBe(true);
    expect(matcher.test("/oauth/consent")).toBe(true);
    expect(matcher.test("/_next/static/chunks/app.js")).toBe(false);
    expect(matcher.test("/licenses/fonts.txt")).toBe(false);
  });
});

describe("the session hint redirect (§5.1)", () => {
  it("sends a visitor without the hint cookie to the email entry, keeping where they were going", () => {
    const response = proxy(new NextRequest("https://app.symplist.test/settings/account?tab=name"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/signin");
    expect(location.searchParams.get("next")).toBe("/settings/account?tab=name");
    // The policy is still set, so the redirect page renders under the same rules.
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("adds no return path for the workspace home", () => {
    const location = new URL(
      proxy(new NextRequest("https://app.symplist.test/now")).headers.get("location") ?? "",
    );
    expect(location.pathname).toBe("/signin");
    expect(location.searchParams.get("next")).toBeNull();
  });

  it("never redirects the sign-in screens themselves", () => {
    for (const path of ["/signin", "/signin/create", "/signin/verify"]) {
      const response = proxy(new NextRequest(`https://app.symplist.test${path}`));
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-request-x-nonce")).toMatch(/^[A-Za-z0-9+/]{24}$/);
    }
  });

  it("lets a request with the hint cookie through to the gate, which is the real check", () => {
    for (const path of ["/now", "/access", "/welcome", "/admin/invites", "/vault"]) {
      const response = proxy(signedInRequest(`https://app.symplist.test${path}`));
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("redirects every protected route group when the hint is missing", () => {
    for (const path of ["/", "/access", "/welcome", "/admin/invites", "/vault", "/oauth/consent"]) {
      const response = proxy(new NextRequest(`https://app.symplist.test${path}`));
      expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/signin");
    }
  });
});
