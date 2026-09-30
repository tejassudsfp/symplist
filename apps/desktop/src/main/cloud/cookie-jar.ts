/**
 * The cookie jar for the main process's cloud client.
 *
 * A browser jar cannot express what this app needs, which is the reason this exists rather than
 * `net.fetch` and Chromium's cookie store. Two tiers:
 *
 *   - **session** — one cookie, persisted through `SecretStore` so a restart does not ask for another
 *     email code. The api sends `__Host-sym_session` in production and `sym_session` elsewhere
 *     (`apps/api/src/common/auth/session-cookies.ts`), so the name is taken from the response and never
 *     assumed.
 *   - **volatile** — everything else, kept in memory only and gone when the process exits. The Vault
 *     cookie (`sym_vault`, `SameSite=Strict`, one hour) lives here: a restart must never leave a vault
 *     silently unlocked, and that guarantee is this tier's whole purpose.
 *
 * `sym_hint` is dropped. It exists so the Next proxy can redirect a signed-out visitor before asking
 * the api; the desktop renderer is served by a Next server that never sees the cloud session, and
 * `GET /v1/me` is the authority either way.
 *
 * An unrecognised cookie lands in the volatile tier, not the session tier. That way a cookie the api
 * adds later works for the session it was set in and simply does not survive a restart, instead of
 * being written to disk by a store that was not told about it.
 */

/** Which tier a cookie belongs in. */
export type CookieTier = "session" | "volatile" | "ignored";

export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  /** Epoch milliseconds, or null for a session cookie with no expiry of its own. */
  readonly expiresAt: number | null;
}

/**
 * The tier a cookie name belongs in. `__Host-` and `__Secure-` are prefixes the api adds in production
 * only, so they are stripped before the name is recognised.
 */
export function classifyCookie(name: string): CookieTier {
  const bare = name.replace(/^__(?:Host|Secure)-/, "");
  if (bare === "sym_session") return "session";
  if (bare === "sym_hint") return "ignored";
  return "volatile";
}

/** One `Set-Cookie` value, parsed into what this jar keeps. */
export interface ParsedSetCookie extends StoredCookie {
  /** The api is deleting this cookie: an empty value, `Max-Age=0`, or an expiry in the past. */
  readonly deleted: boolean;
}

/**
 * Parses one `Set-Cookie` header value. Only `Max-Age` and `Expires` are read: `Path`, `Domain`,
 * `Secure`, `HttpOnly` and `SameSite` are browser scoping rules, and this jar has exactly one scope —
 * requests this process makes to one api origin — so honouring them would add failure modes without
 * adding a defence.
 */
export function parseSetCookie(header: string, now: number): ParsedSetCookie | null {
  const [pair = "", ...attributes] = header.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (name.length === 0) return null;

  let expiresAt: number | null = null;
  let maxAgeSeconds: number | null = null;
  for (const attribute of attributes) {
    const index = attribute.indexOf("=");
    if (index < 0) continue;
    const key = attribute.slice(0, index).trim().toLowerCase();
    const raw = attribute.slice(index + 1).trim();
    if (key === "max-age") {
      const seconds = Number.parseInt(raw, 10);
      if (Number.isFinite(seconds)) maxAgeSeconds = seconds;
    } else if (key === "expires") {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
  }
  // Max-Age wins over Expires, as the cookie specification requires.
  if (maxAgeSeconds !== null) expiresAt = now + maxAgeSeconds * 1000;

  // `res.clearCookie` in Express sends an empty value with an expiry in 1970; `Max-Age=0` is the other
  // spelling. Either way the api is saying this cookie is gone, which is not the same as a cookie that
  // merely aged out mid-session, but the jar's response to both is to forget it.
  const deleted =
    value.length === 0 || maxAgeSeconds === 0 || (expiresAt !== null && expiresAt <= now);
  return { name, value, expiresAt, deleted };
}

/** Serialises cookies into a `Cookie` request header value, or null when there is nothing to send. */
export function cookieHeaderValue(cookies: readonly StoredCookie[]): string | null {
  const pairs = cookies.map((cookie) => `${cookie.name}=${cookie.value}`);
  return pairs.length === 0 ? null : pairs.join("; ");
}

/**
 * The jar. It holds at most one session cookie — the api issues one session per sign-in and replaces it
 * on the next — and any number of volatile ones.
 */
export class CookieJar {
  private sessionCookie: StoredCookie | null = null;
  private readonly volatileCookies = new Map<string, StoredCookie>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Consumes the `Set-Cookie` headers of one response. Called by the cloud client before the response
   * reaches the renderer, which is also where those headers are removed.
   */
  acceptSetCookies(headers: readonly string[]): void {
    const now = this.now();
    for (const header of headers) {
      const parsed = parseSetCookie(header, now);
      if (!parsed) continue;
      const tier = classifyCookie(parsed.name);
      if (tier === "ignored") continue;
      if (parsed.deleted) {
        if (tier === "session") this.sessionCookie = null;
        else this.volatileCookies.delete(parsed.name);
        continue;
      }
      const stored: StoredCookie = {
        name: parsed.name,
        value: parsed.value,
        expiresAt: parsed.expiresAt,
      };
      if (tier === "session") this.sessionCookie = stored;
      else this.volatileCookies.set(parsed.name, stored);
    }
  }

  /** The `Cookie` header for the next request, or null while there is nothing to send. */
  header(): string | null {
    return cookieHeaderValue(this.cookies());
  }

  /** Every unexpired cookie, session tier first. Expired ones are dropped as they are noticed. */
  cookies(): readonly StoredCookie[] {
    const now = this.now();
    const result: StoredCookie[] = [];
    if (this.sessionCookie) {
      if (isExpired(this.sessionCookie, now)) this.sessionCookie = null;
      else result.push(this.sessionCookie);
    }
    for (const [name, cookie] of [...this.volatileCookies]) {
      if (isExpired(cookie, now)) this.volatileCookies.delete(name);
      else result.push(cookie);
    }
    return result;
  }

  /**
   * The session cookie, for the persister. This is the only accessor that reaches a cookie's value, and
   * it deliberately cannot return a volatile one: `session-state.ts` writes whatever this hands it to
   * disk, so the tier separation has to be enforced here rather than trusted there.
   */
  session(): StoredCookie | null {
    const cookie = this.sessionCookie;
    if (!cookie) return null;
    if (isExpired(cookie, this.now())) {
      this.sessionCookie = null;
      return null;
    }
    return cookie;
  }

  /** Restores a persisted session cookie on launch. Refused if it has already expired. */
  restoreSession(cookie: StoredCookie): boolean {
    if (classifyCookie(cookie.name) !== "session") return false;
    if (cookie.value.length === 0 || isExpired(cookie, this.now())) return false;
    this.sessionCookie = cookie;
    return true;
  }

  /** Forgets everything: sign-out, a revoked session, or a blob that turned out to be dead. */
  clear(): void {
    this.sessionCookie = null;
    this.volatileCookies.clear();
  }

  /** Forgets the volatile tier only — used when a vault should be relocked without signing out. */
  clearVolatile(): void {
    this.volatileCookies.clear();
  }
}

function isExpired(cookie: StoredCookie, now: number): boolean {
  return cookie.expiresAt !== null && cookie.expiresAt <= now;
}
