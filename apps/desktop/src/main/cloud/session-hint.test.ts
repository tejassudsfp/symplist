import { describe, expect, it, vi } from "vitest";
import { clearSessionHint, SESSION_HINT_COOKIE, setSessionHint } from "./session-hint.ts";

/**
 * The renderer's `sym_hint`.
 *
 * What makes this worth a test is that its absence is not a degraded experience but a loop: the
 * proxy redirects a hintless navigation to `/signin`, `/signin` asks `GET /v1/me`, main answers from
 * the real session that the user is signed in, and the page navigates back. Nothing errors, nothing
 * logs, and the app sits on "You're already signed in. Opening your account…" forever.
 */

function fakeSession() {
  const set = vi.fn(async (_cookie: Record<string, unknown>) => undefined);
  const remove = vi.fn(async (_url: string, _name: string) => undefined);
  return { session: { cookies: { set, remove } } as never, set, remove };
}

const ORIGIN = "http://127.0.0.1:53004";

describe("the renderer's session hint", () => {
  it("is written for the loopback origin the renderer is served from, never the cloud", async () => {
    const fake = fakeSession();
    await setSessionHint({ session: fake.session, origin: ORIGIN });
    expect(fake.set).toHaveBeenCalledTimes(1);
    const cookie = fake.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cookie.url).toBe(ORIGIN);
    expect(cookie.name).toBe(SESSION_HINT_COOKIE);
  });

  it("carries no session material, because it is a presence flag and nothing else", async () => {
    // The proxy asks only whether the cookie exists. Anything else in the value would be a secret
    // handed to a renderer that is deliberately kept sessionless.
    const fake = fakeSession();
    await setSessionHint({ session: fake.session, origin: ORIGIN });
    const cookie = fake.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cookie.value).toBe("1");
    expect(JSON.stringify(cookie)).not.toMatch(/sym_session|__Host|token|bearer/iu);
  });

  it("is removed when the session ends, so the next navigation goes straight to sign-in", async () => {
    const fake = fakeSession();
    await clearSessionHint({ session: fake.session, origin: ORIGIN });
    expect(fake.remove).toHaveBeenCalledWith(ORIGIN, SESSION_HINT_COOKIE);
  });

  it("uses the same cookie name the proxy checks", () => {
    // Drift here reintroduces the loop silently: main would set a cookie nobody reads, and the proxy
    // would keep redirecting a signed-in user.
    expect(SESSION_HINT_COOKIE).toBe("sym_hint");
  });
});
