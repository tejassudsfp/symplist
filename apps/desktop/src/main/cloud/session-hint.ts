import type { Session } from "electron";

/**
 * The renderer's copy of `sym_hint`.
 *
 * The cookie jar drops `sym_hint` on the way in, and that is right: it is not the session, and
 * `GET /v1/me` is the authority for what a screen may show. What that reasoning missed is that the
 * renderer is served by a Next server whose middleware still enforces the hint, and enforces it
 * against a cookie the renderer can never receive — because the session is held in main.
 *
 * The result was a loop rather than a degraded experience. A signed-in user navigating to the
 * workspace was redirected to `/signin` for having no hint; `/signin` asked `GET /v1/me`, which
 * answered through the bridge from main's real session, decided the user was signed in, and
 * navigated to the workspace again. "You're already signed in. Opening your account…" forever.
 *
 * So main gives the renderer the hint, which it is free to do: the cookie is explicitly non-secret,
 * carries no session material, and its only job is to let the proxy redirect a signed-out visitor
 * without a round trip. Mirroring it keeps that fast path working and costs nothing, where removing
 * the redirect for the desktop would make every signed-out navigation render the shell first.
 *
 * It is written for the loopback origin the renderer is actually served from, so it never reaches
 * the cloud, and it is removed the moment the session ends.
 */
export const SESSION_HINT_COOKIE = "sym_hint";

export interface SessionHintTarget {
  readonly session: Pick<Session, "cookies">;
  /** The renderer's own origin, e.g. `http://127.0.0.1:53004`. */
  readonly origin: string;
}

/** Gives the renderer the hint, so the proxy stops redirecting a signed-in user to sign-in. */
export async function setSessionHint(target: SessionHintTarget): Promise<void> {
  await target.session.cookies.set({
    url: target.origin,
    name: SESSION_HINT_COOKIE,
    // The value is never read — the proxy asks only whether the cookie is present.
    value: "1",
    // A session cookie: a restart re-establishes it from main's restore, or does not, and either
    // way the renderer should not start from a stale claim.
    httpOnly: false,
    secure: false,
  });
}

/** Takes it away, so the proxy sends the next navigation to sign-in without waiting on the api. */
export async function clearSessionHint(target: SessionHintTarget): Promise<void> {
  await target.session.cookies.remove(target.origin, SESSION_HINT_COOKIE);
}
