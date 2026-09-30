/**
 * The one function in this app that talks to the cloud.
 *
 * Everything about it is deliberate. It sets `Origin` itself, because the api compares that header to
 * its configured `WEB_ORIGIN` by string equality and a Chromium renderer cannot set it — a native
 * client is the only kind that can meet the rule honestly. `apps/e2e/src/helpers/phase-e.ts` already
 * calls the api this way from a Playwright request context, so this matches the repo rather than
 * inventing a client.
 *
 * It follows that the `Origin` header no longer tells the api which first-party client is calling. The
 * defences that matter are unchanged — the session cookie's secrecy, and the session-bound CSRF token
 * the api checks in `AccessGuard` — but if the api ever tightens to `Origin` plus `Sec-Fetch-Site`, or
 * starts distinguishing browser clients, this is the single function to change. Keeping it single is the
 * reason it exists.
 *
 * It builds its own request init rather than forwarding the renderer's. The renderer's `credentials`,
 * `mode`, `redirect` and `Cookie` never reach undici; the renderer asks for a method, a path, a small
 * set of headers and a body, and gets a status, headers and a body back. Cookies are consumed into the
 * jar on the way in and stripped from what the renderer sees, so the session token exists in exactly one
 * process.
 */
import type { MainLog } from "../log.ts";
import type { CookieJar } from "./cookie-jar.ts";

/**
 * Request headers the renderer may set. An allowlist, not a denylist: the interesting attack is a header
 * nobody thought of, and `apps/web`'s `ApiClient` sends exactly these.
 *
 * `X-Symplist-CSRF` carries both CSRF classes — the session-bound token on `app` mutations and the
 * literal `1` that forces a preflight on `pre_session` sign-in routes (`packages/contracts/src/common/
 * http.ts`, `csrfHeader`). `Idempotency-Key` is required by mutations with side effects.
 */
export const forwardableRequestHeaders: readonly string[] = Object.freeze([
  "accept",
  "accept-language",
  "content-type",
  "idempotency-key",
  "x-symplist-csrf",
]);

/**
 * Response headers the renderer receives. `ApiClient` needs the content type to parse the body,
 * `Retry-After` to honour a rate limit, and `X-Request-Id` so a reported failure can be traced. Nothing
 * else is useful to a client that does no caching and follows no redirects — and `Set-Cookie` is not on
 * this list, which is the point.
 */
export const forwardableResponseHeaders: readonly string[] = Object.freeze([
  "content-type",
  "retry-after",
  "x-request-id",
]);

/** Methods the cloud client will issue. `ApiClient` uses these five and the api accepts no others. */
export const allowedMethods: readonly string[] = Object.freeze([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export interface CloudRequest {
  readonly method: string;
  /** An absolute path on the api origin, for example `/v1/me?limit=20`. */
  readonly path: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string | null;
  readonly signal?: AbortSignal;
}

export interface CloudResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/** Why a request was refused before it left the process, or a response discarded after it arrived. */
export type CloudRefusalReason = "method" | "path" | "redirect";

/**
 * A request this client will not make, or a response it will not hand on. It is not the api's answer, so
 * it never carries a status: the renderer sees it as a network failure, which is what it is.
 */
export class CloudRequestRefused extends Error {
  readonly reason: CloudRefusalReason;
  constructor(reason: CloudRefusalReason) {
    super(`symplist: refused a cloud request (${reason})`);
    this.name = "CloudRequestRefused";
    this.reason = reason;
  }
}

export interface CloudHttpOptions {
  readonly apiOrigin: string;
  /** The value of the `Origin` header: the api's own `WEB_ORIGIN`. See the module comment. */
  readonly webOrigin: string;
  readonly jar: CookieJar;
  readonly log: MainLog;
  readonly fetchImpl?: typeof fetch;
}

/** Sends one request to the api. Returns the response with cookies consumed and stripped. */
export type CloudHttp = (request: CloudRequest) => Promise<CloudResponse>;

function pick(
  headers: readonly (readonly [string, string])[],
  allowed: readonly string[],
): [string, string][] {
  const result: [string, string][] = [];
  for (const [name, value] of headers) {
    if (allowed.includes(name.toLowerCase())) result.push([name, value]);
  }
  return result;
}

/**
 * Reads the response's `Set-Cookie` values. `Headers.getSetCookie()` is the only correct way: a
 * `Set-Cookie` list joined with commas cannot be split again, because `Expires` dates contain commas.
 * It is present in Electron 44's bundled Node 24; the fallback covers a fetch implementation injected by
 * a test rather than a runtime we ship.
 */
function setCookieValues(headers: Headers): readonly string[] {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single === null ? [] : [single];
}

/**
 * Builds the cloud client. Nothing here touches Electron, so the whole outbound path — the `Origin`
 * header, the cookie tiers, the redirect refusal — is tested under plain Node.
 */
export function createCloudHttp(options: CloudHttpOptions): CloudHttp {
  const { apiOrigin, jar, log } = options;
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  return async function request(cloudRequest: CloudRequest): Promise<CloudResponse> {
    const method = cloudRequest.method.toUpperCase();
    if (!allowedMethods.includes(method)) throw new CloudRequestRefused("method");
    const url = resolveApiUrl(apiOrigin, cloudRequest.path);
    if (!url) throw new CloudRequestRefused("path");

    const headers = new Headers(pick(cloudRequest.headers, forwardableRequestHeaders));
    // The single place the header is set. See the module comment before moving it.
    headers.set("Origin", options.webOrigin);
    const cookie = jar.header();
    if (cookie !== null) headers.set("Cookie", cookie);

    const response = await fetchImpl(url, {
      method,
      headers,
      ...(cloudRequest.body !== null && method !== "GET" ? { body: cloudRequest.body } : {}),
      ...(cloudRequest.signal ? { signal: cloudRequest.signal } : {}),
      // A redirect is handled below rather than followed: following one would re-send the session
      // cookie to whatever `Location` names.
      redirect: "manual",
      cache: "no-store",
    });

    if (response.status >= 300 && response.status < 400) {
      // The cookies of a redirect are not consumed and its body is not read. `/v1` answers no
      // redirects, so this is either a misconfigured proxy in front of the api or something worse.
      log.warn("cloud.redirect_refused", { status: response.status });
      throw new CloudRequestRefused("redirect");
    }

    jar.acceptSetCookies(setCookieValues(response.headers));
    const body = await response.text();
    return {
      status: response.status,
      headers: pick([...response.headers], forwardableResponseHeaders),
      body,
    };
  };
}

/**
 * The absolute URL for a path on the api origin, or null when the path is not one this client may
 * request. The rules are the renderer's `ApiClient.url` plus the pinning this client adds: an absolute
 * path, no protocol-relative `//host` that would change origin, no backslash a proxy might normalise
 * into a slash, and a `/v1/` prefix — the session cookie is scoped to the whole api host, so without the
 * prefix a compromised renderer could aim an authenticated request at `/oauth/` or `/internal/v1/`.
 */
export function resolveApiUrl(apiOrigin: string, path: string): URL | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(path, apiOrigin);
  } catch {
    return null;
  }
  if (url.origin !== apiOrigin) return null;
  if (!url.pathname.startsWith("/v1/")) return null;
  return url;
}
