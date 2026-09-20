import type { Response } from "express";
import { describe, expect, it } from "vitest";
import {
  clearSessionCookies,
  cookieNames,
  hintCookieDomain,
  hintCookieOptions,
  sessionCookieOptions,
  setSessionCookies,
} from "./session-cookies.ts";

const production = {
  NODE_ENV: "production" as const,
  WEB_ORIGIN: "https://symplist.tejassuds.com",
  API_ORIGIN: "https://api.tejassuds.com",
};
const development = {
  NODE_ENV: "development" as const,
  WEB_ORIGIN: "http://localhost:3000",
  API_ORIGIN: "http://localhost:4000",
};

function recordingResponse() {
  const cookies: {
    name: string;
    value?: string;
    options: Record<string, unknown>;
    cleared: boolean;
  }[] = [];
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      cookies.push({ name, value, options, cleared: false });
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      cookies.push({ name, options, cleared: true });
    },
  } as unknown as Response;
  return { res, cookies };
}

describe("session cookies (§5.1)", () => {
  it("uses the host-only __Host- cookie in production and sym_session elsewhere", () => {
    expect(cookieNames(production)).toMatchObject({
      session: "__Host-sym_session",
      vault: "__Host-sym_vault",
      sharePrefix: "__Host-sym_share_",
      hint: "sym_hint",
    });
    expect(cookieNames(development)).toMatchObject({ session: "sym_session", hint: "sym_hint" });
  });

  it("sets HttpOnly, SameSite=Lax, Path=/, no Domain and Secure in production", () => {
    expect(sessionCookieOptions(production, 1000)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
      maxAge: 1000,
    });
    expect(sessionCookieOptions(development, 1000).secure).toBe(false);
    expect(sessionCookieOptions(production, 1000)).not.toHaveProperty("domain");
  });

  it("scopes sym_hint to the parent domain shared by web and api", () => {
    expect(hintCookieDomain(production)).toBe("tejassuds.com");
    expect(hintCookieOptions(production, 5)).toMatchObject({
      domain: "tejassuds.com",
      secure: true,
    });
    expect(hintCookieDomain(development)).toBeUndefined();
    expect(
      hintCookieDomain({
        WEB_ORIGIN: "http://127.0.0.1:3000",
        API_ORIGIN: "http://127.0.0.1:4000",
      }),
    ).toBeUndefined();
    expect(
      hintCookieDomain({ WEB_ORIGIN: "https://a.example.org", API_ORIGIN: "https://b.other.net" }),
    ).toBeUndefined();
    expect(
      hintCookieDomain({
        WEB_ORIGIN: "https://app.symplist.example.com",
        API_ORIGIN: "https://api.symplist.example.com",
      }),
    ).toBe("symplist.example.com");
  });

  it("sets both cookies with the session lifetime and clears session, Vault and hint cookies", () => {
    const { res, cookies } = recordingResponse();
    setSessionCookies(res, production, { token: "tok", expiresAt: 10_000 }, 4_000);
    expect(cookies).toEqual([
      {
        name: "__Host-sym_session",
        value: "tok",
        options: sessionCookieOptions(production, 6_000),
        cleared: false,
      },
      {
        name: "sym_hint",
        value: "1",
        options: hintCookieOptions(production, 6_000),
        cleared: false,
      },
    ]);
    const cleared = recordingResponse();
    clearSessionCookies(cleared.res, production);
    expect(cleared.cookies.map((cookie) => [cookie.name, cookie.cleared])).toEqual([
      ["__Host-sym_session", true],
      ["__Host-sym_vault", true],
      ["sym_hint", true],
    ]);
    expect(cleared.cookies[2]?.options).toMatchObject({ domain: "tejassuds.com" });
  });
});
