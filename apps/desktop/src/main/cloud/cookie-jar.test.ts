import { describe, expect, it } from "vitest";
import { CookieJar, classifyCookie, parseSetCookie } from "./cookie-jar.ts";

const NOW = 1_700_000_000_000;

describe("classifying a cookie", () => {
  it("recognises the session cookie under both of the api's names", () => {
    // Production adds the __Host- prefix; development and test do not
    // (apps/api/src/common/auth/session-cookies.ts).
    expect(classifyCookie("__Host-sym_session")).toBe("session");
    expect(classifyCookie("sym_session")).toBe("session");
  });

  it("keeps the vault cookie out of the session tier so a restart cannot leave a vault unlocked", () => {
    expect(classifyCookie("__Host-sym_vault")).toBe("volatile");
    expect(classifyCookie("sym_vault")).toBe("volatile");
  });

  it("ignores the hint cookie, which exists only for the Next proxy", () => {
    expect(classifyCookie("sym_hint")).toBe("ignored");
  });

  it("puts anything it does not recognise in the volatile tier", () => {
    // A cookie the api adds later works for its session and simply does not survive a restart.
    expect(classifyCookie("sym_something_new")).toBe("volatile");
    expect(classifyCookie("__Host-sym_share_abc")).toBe("volatile");
  });
});

describe("parsing Set-Cookie", () => {
  it("reads the name, the value and Max-Age", () => {
    expect(
      parseSetCookie("sym_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60", NOW),
    ).toEqual({ name: "sym_session", value: "abc", expiresAt: NOW + 60_000, deleted: false });
  });

  it("lets Max-Age win over Expires, as the cookie specification requires", () => {
    const parsed = parseSetCookie(
      "sym_session=abc; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Max-Age=30",
      NOW,
    );
    expect(parsed?.expiresAt).toBe(NOW + 30_000);
  });

  it("reads Expires when there is no Max-Age, commas and all", () => {
    const parsed = parseSetCookie("sym_session=abc; Expires=Wed, 21 Oct 2099 07:28:00 GMT", NOW);
    expect(parsed?.expiresAt).toBe(Date.parse("Wed, 21 Oct 2099 07:28:00 GMT"));
    expect(parsed?.deleted).toBe(false);
  });

  it("treats every spelling of a deletion as a deletion", () => {
    // Express's clearCookie sends an empty value with a 1970 expiry; Max-Age=0 is the other spelling.
    expect(
      parseSetCookie("sym_session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT", NOW)?.deleted,
    ).toBe(true);
    expect(parseSetCookie("sym_session=abc; Max-Age=0", NOW)?.deleted).toBe(true);
    expect(parseSetCookie("sym_session=abc; Max-Age=-1", NOW)?.deleted).toBe(true);
  });

  it("returns nothing for a header that is not a cookie", () => {
    expect(parseSetCookie("nonsense", NOW)).toBeNull();
    expect(parseSetCookie("=value", NOW)).toBeNull();
  });
});

describe("the cookie jar", () => {
  function jar(now = NOW) {
    let clock = now;
    const instance = new CookieJar(() => clock);
    return { jar: instance, advance: (ms: number) => (clock += ms) };
  }

  it("sends the session cookie under whichever name the api used", () => {
    const { jar: instance } = jar();
    instance.acceptSetCookies(["__Host-sym_session=tok; Path=/; Max-Age=600"]);
    expect(instance.header()).toBe("__Host-sym_session=tok");
    expect(instance.session()?.name).toBe("__Host-sym_session");
  });

  it("sends the vault cookie but never hands it to the persister", () => {
    const { jar: instance } = jar();
    instance.acceptSetCookies([
      "sym_session=tok; Max-Age=600",
      "sym_vault=vault; Max-Age=3600; SameSite=Strict",
    ]);
    expect(instance.header()).toBe("sym_session=tok; sym_vault=vault");
    // The only accessor that reaches a value is session(), and it cannot return a volatile cookie. This
    // is the whole guarantee that a restart does not leave a vault silently unlocked.
    expect(instance.session()?.name).toBe("sym_session");
    expect(instance.session()?.value).toBe("tok");
  });

  it("drops the hint cookie entirely", () => {
    const { jar: instance } = jar();
    instance.acceptSetCookies(["sym_session=tok; Max-Age=600", "sym_hint=1; Max-Age=600"]);
    expect(instance.header()).toBe("sym_session=tok");
  });

  it("forgets a cookie the api deleted", () => {
    const { jar: instance } = jar();
    instance.acceptSetCookies(["sym_session=tok; Max-Age=600", "sym_vault=v; Max-Age=600"]);
    instance.acceptSetCookies([
      "sym_session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "sym_vault=; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ]);
    expect(instance.header()).toBeNull();
    expect(instance.session()).toBeNull();
  });

  it("stops sending a cookie once it has expired", () => {
    const { jar: instance, advance } = jar();
    instance.acceptSetCookies(["sym_session=tok; Max-Age=10", "sym_vault=v; Max-Age=100"]);
    advance(20_000);
    expect(instance.header()).toBe("sym_vault=v");
    expect(instance.session()).toBeNull();
    advance(200_000);
    expect(instance.header()).toBeNull();
  });

  it("replaces the session cookie when the api issues a new one", () => {
    const { jar: instance } = jar();
    instance.acceptSetCookies(["sym_session=first; Max-Age=600"]);
    instance.acceptSetCookies(["sym_session=second; Max-Age=600"]);
    expect(instance.session()?.value).toBe("second");
    expect(instance.header()).toBe("sym_session=second");
  });

  it("restores only a session cookie, and only one that is still alive", () => {
    const { jar: instance } = jar();
    expect(instance.restoreSession({ name: "sym_vault", value: "v", expiresAt: NOW + 1000 })).toBe(
      false,
    );
    expect(instance.restoreSession({ name: "sym_session", value: "", expiresAt: null })).toBe(
      false,
    );
    expect(instance.restoreSession({ name: "sym_session", value: "tok", expiresAt: NOW - 1 })).toBe(
      false,
    );
    expect(instance.header()).toBeNull();
    expect(
      instance.restoreSession({ name: "__Host-sym_session", value: "tok", expiresAt: NOW + 1000 }),
    ).toBe(true);
    expect(instance.header()).toBe("__Host-sym_session=tok");
  });

  it("clears both tiers, and the volatile tier on its own", () => {
    const { jar: instance } = jar();
    instance.acceptSetCookies(["sym_session=tok; Max-Age=600", "sym_vault=v; Max-Age=600"]);
    instance.clearVolatile();
    expect(instance.header()).toBe("sym_session=tok");
    instance.clear();
    expect(instance.header()).toBeNull();
    expect(instance.session()).toBeNull();
  });
});
