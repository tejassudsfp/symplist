import { z } from "zod";
import { publicOrigins } from "../public-config.ts";
import {
  ApiAbortedError,
  ApiConfigurationError,
  ApiNetworkError,
  ApiProtocolError,
  errorFromResponse,
  ServerSideApiCallError,
} from "./errors.ts";
import { IDEMPOTENCY_HEADER } from "./idempotency.ts";

/** The CSRF header every unsafe cookie-authenticated request carries (§5.3). */
export const CSRF_HEADER = "X-Symplist-CSRF";
/** Issues the session-bound CSRF token for the `app` route class (§5.3). */
export const CSRF_TOKEN_PATH = "/v1/auth/csrf";

/**
 * Route classes the browser calls (§5.3): `app` sends the session-bound token; `pre_session` (lookup,
 * signup, OTP send and verify) sends `X-Symplist-CSRF: 1` to force a preflight.
 */
export type CsrfClass = "app" | "pre_session";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const csrfTokenResponseSchema = z.object({ token: z.string().min(1) });

export interface RequestOptions<T> {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** JSON request body. */
  readonly body?: unknown;
  /** Validates the success body; the result is typed from the schema. */
  readonly schema?: z.ZodType<T>;
  /** Required by mutations with side effects (§6.1); reuse the same key when retrying an intent. */
  readonly idempotencyKey?: string;
  /** CSRF class for unsafe methods; defaults to `app`. Ignored for GET. */
  readonly csrf?: CsrfClass;
  readonly signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** The API origin, for example `https://api.example`. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** Overridable for tests; defaults to detecting a browser `window`. */
  readonly isBrowser?: () => boolean;
}

const unsafeMethods = new Set<HttpMethod>(["POST", "PUT", "PATCH", "DELETE"]);

function defaultIsBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * The browser HTTP client for `/v1/*` (§5.1, §5.3, §6). It always sends cookies
 * (`credentials: 'include'`), adds the CSRF header to unsafe methods, parses the error envelope into
 * typed errors, and refuses to run outside a browser so server code can never call the API.
 */
export class ApiClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly isBrowser: () => boolean;
  private csrfToken: string | null = null;
  private csrfRequest: Promise<string> | null = null;

  constructor(options: ApiClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new ApiConfigurationError("The API origin is not a valid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ApiConfigurationError("The API origin must use https or http");
    }
    this.origin = url.origin;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.isBrowser = options.isBrowser ?? defaultIsBrowser;
  }

  get<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T> {
    return this.request("GET", path, options);
  }

  post<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T> {
    return this.request("POST", path, options);
  }

  put<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T> {
    return this.request("PUT", path, options);
  }

  patch<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T> {
    return this.request("PATCH", path, options);
  }

  delete<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T> {
    return this.request("DELETE", path, options);
  }

  /** Drops the cached CSRF token (sign-out, account switch, or after the API rejects it). */
  clearCsrfToken(): void {
    this.csrfToken = null;
    this.csrfRequest = null;
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: RequestOptions<T> = {},
  ): Promise<T> {
    if (!this.isBrowser()) throw new ServerSideApiCallError();
    const url = this.url(path, options.query);
    const headers = new Headers({ Accept: "application/json" });
    const unsafe = unsafeMethods.has(method);
    const csrfClass: CsrfClass = options.csrf ?? "app";
    if (unsafe) {
      headers.set(
        CSRF_HEADER,
        csrfClass === "pre_session" ? "1" : await this.token(options.signal),
      );
    }
    if (options.idempotencyKey !== undefined) {
      if (!unsafe) throw new TypeError("Idempotency keys apply only to mutations");
      if (options.idempotencyKey.trim().length === 0) throw new TypeError("Empty idempotency key");
      headers.set(IDEMPOTENCY_HEADER, options.idempotencyKey);
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      if (method === "GET") throw new TypeError("GET requests have no body");
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }
    const response = await this.send(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 403 && unsafe && csrfClass === "app") this.clearCsrfToken();
      throw await errorFromResponse(response);
    }
    return this.parseSuccess(response, options.schema);
  }

  private url(path: string, query: RequestOptions<unknown>["query"]): URL {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
      throw new TypeError("API paths must be absolute paths on the API origin, such as /v1/tasks");
    }
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new TypeError("API paths must stay on the API origin");
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        credentials: "include",
        mode: "cors",
        cache: "no-store",
        // Never follow a redirect with credentials attached.
        redirect: "error",
      });
    } catch (cause) {
      if (init.signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw new ApiAbortedError();
      }
      throw new ApiNetworkError({ cause });
    }
  }

  private async parseSuccess<T>(response: Response, schema: z.ZodType<T> | undefined): Promise<T> {
    if (response.status === 204 || response.status === 205) {
      if (schema) {
        const empty = schema.safeParse(undefined);
        if (!empty.success) {
          throw new ApiProtocolError(response.status, "Expected a response body", {
            cause: empty.error,
          });
        }
        return empty.data;
      }
      return undefined as T;
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (cause) {
      throw new ApiProtocolError(response.status, "The response was not valid JSON", { cause });
    }
    if (!schema) return data as T;
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new ApiProtocolError(response.status, "The response did not match its schema", {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  private async token(signal: AbortSignal | undefined): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    if (!this.csrfRequest) {
      const pending = (async () => {
        const response = await this.send(this.url(CSRF_TOKEN_PATH, undefined), {
          method: "GET",
          headers: new Headers({ Accept: "application/json" }),
        });
        if (!response.ok) throw await errorFromResponse(response);
        const { token } = await this.parseSuccess(response, csrfTokenResponseSchema);
        this.csrfToken = token;
        return token;
      })();
      this.csrfRequest = pending;
      pending.then(
        () => {
          if (this.csrfRequest === pending) this.csrfRequest = null;
        },
        () => {
          if (this.csrfRequest === pending) this.csrfRequest = null;
        },
      );
    }
    const request = this.csrfRequest;
    if (!signal) return request;
    if (signal.aborted) throw new ApiAbortedError();
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new ApiAbortedError()), { once: true });
      }),
    ]);
  }
}

let sharedClient: ApiClient | null = null;

/**
 * A response as the desktop shell hands it over: plain data, never a `Response`.
 *
 * `contextBridge` copies own enumerable properties between the preload's world and this one, and every
 * useful part of a `Response` — `status`, `ok`, `headers`, `json()` — lives on its prototype. One built
 * on the far side of the bridge arrives here as an empty object, so the shell sends the three pieces
 * that do clone and this module puts them back together.
 */
interface DesktopCloudResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/**
 * The transport the desktop shell installs on `window.symplist.cloud`. Matched structurally, never
 * imported: `apps/web` must not depend on `apps/desktop`.
 */
interface DesktopCloudTransport {
  readonly apiOrigin: string;
  readonly fetch: typeof fetch;
}

/** Rebuilds the shell's plain answer into the `Response` the rest of this file already understands. */
function responseFrom(payload: DesktopCloudResponse): Response {
  // 204, 205 and 304 must be constructed with a null body, or the `Response` constructor throws.
  const bodyless = payload.status === 204 || payload.status === 205 || payload.status === 304;
  return new Response(bodyless ? null : payload.body, {
    status: payload.status,
    headers: payload.headers.map(([name, value]) => [name, value]),
  });
}

/**
 * The desktop shell's transport when this page is running inside it, or null in a browser.
 *
 * In the desktop app every `/v1` call is made by the Electron main process, which holds the session
 * cookie and sets the `Origin` header the api demands — the renderer is served from `http://127.0.0.1:
 * <port>`, which is cross-site to the api, so a browser fetch from here could neither satisfy
 * `RouteClassGuard.checkOrigin` nor be sent the `SameSite=Lax` session cookie. Main answers with a real
 * `Response`, so `errorFromResponse`, `Retry-After` and every schema check below are untouched.
 *
 * The origin comes from the shell rather than from `NEXT_PUBLIC_API_URL`, because the shell is the process
 * that will actually make the request and pins it to its own configured origin anyway.
 */
function desktopCloudTransport(): DesktopCloudTransport | null {
  const cloud = (globalThis as { symplist?: { cloud?: unknown } }).symplist?.cloud;
  if (typeof cloud !== "object" || cloud === null) return null;
  const candidate = cloud as { apiOrigin?: unknown; fetch?: unknown };
  if (typeof candidate.apiOrigin !== "string" || candidate.apiOrigin.length === 0) return null;
  if (typeof candidate.fetch !== "function") return null;
  const bridged = candidate.fetch as (
    input: string,
    init?: RequestInit,
  ) => Promise<DesktopCloudResponse>;
  /*
   * Both conversions happen here, and neither is tidying up.
   *
   * `ApiClient.send` passes a `URL`, which every real `fetch` accepts. This one is not a real fetch: it
   * is a function published through Electron's `contextBridge`, so its arguments are cloned between
   * worlds by copying own enumerable properties. A `URL` has none, so it arrives in the preload as an
   * empty object and `new Request({})` resolves `"[object Object]"` against the renderer's own
   * 127.0.0.1 origin; main then refuses it for a bad origin, correctly and far too late. The answer
   * comes back through the same copy and a `Response` survives it no better — no `status`, no headers,
   * no `json()`. Together those two made every `/v1` call in the desktop app fail, including the first
   * one sign-in makes.
   *
   * Fixed at this seam rather than inside `ApiClient`, because the constraint belongs to the bridge:
   * the browser build passes a `URL` and receives a `Response`, which is correct and worth keeping.
   */
  return {
    apiOrigin: candidate.apiOrigin,
    fetch: async (input, init) =>
      responseFrom(await bridged(input instanceof URL ? input.href : String(input), init)),
  };
}

/** The app-wide client for the configured API origin. Browser only. */
export function getApiClient(): ApiClient {
  if (typeof window === "undefined") throw new ServerSideApiCallError();
  if (!sharedClient) {
    const desktop = desktopCloudTransport();
    if (desktop) {
      // `isBrowser` is asserted rather than detected: this is a real document, and the guard exists to
      // keep server code from calling the api, which the desktop renderer is not.
      sharedClient = new ApiClient({
        baseUrl: desktop.apiOrigin,
        fetch: desktop.fetch,
        isBrowser: () => true,
      });
      return sharedClient;
    }
    const { apiOrigin } = publicOrigins();
    if (!apiOrigin) throw new ApiConfigurationError("NEXT_PUBLIC_API_URL is not configured");
    sharedClient = new ApiClient({ baseUrl: apiOrigin });
  }
  return sharedClient;
}

/** Test support: forgets the shared client so the next call re-detects its transport. */
export function resetApiClientForTests(): void {
  sharedClient = null;
}
