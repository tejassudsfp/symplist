import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parsePublicOrigins } from "../public-config.ts";
import {
  ApiClient,
  CSRF_HEADER,
  CSRF_TOKEN_PATH,
  getApiClient,
  resetApiClientForTests,
} from "./client.ts";
import {
  ApiAbortedError,
  ApiConfigurationError,
  ApiError,
  ApiNetworkError,
  ApiProtocolError,
  isApiError,
  ServerSideApiCallError,
} from "./errors.ts";
import { createIdempotencyKey, IdempotencyKeys } from "./idempotency.ts";

const API = "https://api.symplist.test";

interface Call {
  url: string;
  init: RequestInit;
  headers: Headers;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * The desktop shell's answer shape: plain data, because nothing else survives Electron's context
 * bridge. Modelled here rather than reusing `fakeFetch`, whose `Response` would let the client keep
 * working in a test while failing in the app.
 */
interface ShellResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

function shellResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ShellResponse {
  return {
    status,
    headers: [["Content-Type", "application/json"], ...Object.entries(headers)],
    body: JSON.stringify(body),
  };
}

/** A stand-in for `window.symplist.cloud.fetch`, which takes a URL string and answers plain data. */
function fakeBridge(handler: (url: string, init: RequestInit) => ShellResponse) {
  const urls: unknown[] = [];
  // The raw `init`, unconverted. Reading `init.headers` through `new Headers(...)` would hide the
  // very thing these tests exist to catch, because a `Headers` copies fine inside one realm.
  const inits: RequestInit[] = [];
  const fetchImpl = vi.fn((input: unknown, init: RequestInit = {}) => {
    urls.push(input);
    inits.push(init);
    return Promise.resolve(handler(String(input), init));
  });
  return { fetchImpl, urls, inits };
}

function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init, headers: new Headers(init.headers) });
    return handler(url, init);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function client(handler: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(handler);
  return { api: new ApiClient({ baseUrl: API, fetch: fake.fetchImpl }), calls: fake.calls };
}

const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: "Safe message", requestId: "req_123", ...extra },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ApiClient requests", () => {
  it("always sends credentials and never follows redirects", async () => {
    const { api, calls } = client(() => json(200, { ok: true }));
    await api.get("/v1/tasks", { query: { collection: "now", limit: 20, cursor: undefined } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API}/v1/tasks?collection=now&limit=20`);
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      credentials: "include",
      mode: "cors",
      cache: "no-store",
      redirect: "error",
    });
    expect(calls[0]?.headers.get(CSRF_HEADER)).toBeNull();
    expect(calls[0]?.headers.get("Accept")).toBe("application/json");
  });

  it("bootstraps the session CSRF token once and sends it on unsafe methods", async () => {
    let tokenRequests = 0;
    const { api, calls } = client((url) => {
      if (url.pathname === "/v1/auth/csrf") {
        tokenRequests += 1;
        return json(200, { token: "csrf-token-1" });
      }
      return json(200, { id: "t1" });
    });
    await Promise.all([
      api.post("/v1/tasks", { body: { title: "One" }, idempotencyKey: "key-1" }),
      api.patch("/v1/tasks/t1", { body: { title: "Two" } }),
      api.delete("/v1/things/x"),
    ]);
    expect(tokenRequests).toBe(1);
    const mutations = calls.filter((call) => call.url !== `${API}/v1/auth/csrf`);
    expect(mutations).toHaveLength(3);
    for (const call of mutations) {
      expect(call.headers.get(CSRF_HEADER)).toBe("csrf-token-1");
      expect(call.init.credentials).toBe("include");
    }
    const post = mutations.find((call) => call.init.method === "POST");
    expect(post?.headers.get("Idempotency-Key")).toBe("key-1");
    expect(post?.headers.get("Content-Type")).toBe("application/json");
    expect(post?.init.body).toBe(JSON.stringify({ title: "One" }));
    const tokenCall = calls.find((call) => call.url === `${API}/v1/auth/csrf`);
    expect(tokenCall?.init.credentials).toBe("include");
  });

  it("sends the literal preflight header for pre-session routes without fetching a token", async () => {
    const { api, calls } = client(() => json(200, { exists: true }));
    await api.post("/v1/auth/lookup", { body: { email: "maya@example.com" }, csrf: "pre_session" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get(CSRF_HEADER)).toBe("1");
  });

  it("drops a rejected CSRF token so the next mutation fetches a new one", async () => {
    let issued = 0;
    let rejectNext = true;
    const { api, calls } = client((url) => {
      if (url.pathname === "/v1/auth/csrf") {
        issued += 1;
        return json(200, { token: `token-${issued}` });
      }
      if (rejectNext) {
        rejectNext = false;
        return json(403, envelope("auth.csrf_invalid"));
      }
      return json(200, {});
    });
    await expect(api.post("/v1/a")).rejects.toBeInstanceOf(ApiError);
    await api.post("/v1/a");
    expect(issued).toBe(2);
    expect(calls.at(-1)?.headers.get(CSRF_HEADER)).toBe("token-2");
  });

  it("surfaces a failed token bootstrap as a typed error and does not send the mutation", async () => {
    const { api, calls } = client(() => json(401, envelope("auth.session_required")));
    const error = await api.post("/v1/tasks").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("auth.session_required");
    expect(calls).toHaveLength(1);
  });

  it("validates success bodies against a schema", async () => {
    const schema = z.object({ id: z.string() });
    const ok = client(() => json(200, { id: "t1" }));
    await expect(ok.api.get("/v1/tasks/t1", { schema })).resolves.toEqual({ id: "t1" });
    const bad = client(() => json(200, { id: 7 }));
    await expect(bad.api.get("/v1/tasks/t1", { schema })).rejects.toBeInstanceOf(ApiProtocolError);
    const html = client(() => new Response("<html>", { status: 200 }));
    await expect(html.api.get("/v1/x")).rejects.toBeInstanceOf(ApiProtocolError);
  });

  it("returns undefined for 204 responses", async () => {
    const { api } = client((url) =>
      url.pathname === "/v1/auth/csrf"
        ? json(200, { token: "t" })
        : new Response(null, { status: 204 }),
    );
    await expect(api.delete("/v1/items/i1")).resolves.toBeUndefined();
  });
});

describe("error envelope parsing", () => {
  it("parses codes, details and request ids into ApiError", async () => {
    const { api } = client(() =>
      json(409, envelope("task.archived", { details: { taskId: "t1" } })),
    );
    const error = await api.get("/v1/tasks/t1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError).toMatchObject({
      status: 409,
      code: "task.archived",
      message: "Safe message",
      requestId: "req_123",
      details: { taskId: "t1" },
    });
    expect(apiError.is("task.archived")).toBe(true);
    expect(isApiError(error, "task.archived")).toBe(true);
    expect(isApiError(error, "not_found")).toBe(false);
  });

  it("reads retryAfter from details or the Retry-After header", async () => {
    const fromDetails = client(() =>
      json(503, envelope("rate.limited", { details: { retryAfter: 30 } })),
    );
    const first = (await fromDetails.api.get("/v1/x").catch((e: unknown) => e)) as ApiError;
    expect(first.retryAfterSeconds).toBe(30);
    const fromHeader = client(() => json(503, envelope("rate.limited"), { "Retry-After": "120" }));
    const second = (await fromHeader.api.get("/v1/x").catch((e: unknown) => e)) as ApiError;
    expect(second.retryAfterSeconds).toBe(120);
  });

  it.each([
    ["an HTML error page", () => new Response("<h1>Bad gateway</h1>", { status: 502 })],
    ["a body without the envelope", () => json(500, { message: "boom" })],
    [
      "an envelope missing its request id",
      () => json(404, { error: { code: "not_found", message: "x" } }),
    ],
  ])("reports %s as a protocol error", async (_label, response) => {
    const { api } = client(response);
    const error = await api.get("/v1/x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiProtocolError);
    expect(isApiError(error)).toBe(false);
  });

  it("maps transport failures and aborts", async () => {
    const offline = client(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(offline.api.get("/v1/x")).rejects.toBeInstanceOf(ApiNetworkError);
    const controller = new AbortController();
    const aborting = client(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(aborting.api.get("/v1/x", { signal: controller.signal })).rejects.toBeInstanceOf(
      ApiAbortedError,
    );
  });
});

describe("safety", () => {
  it("never runs outside the browser", async () => {
    const { fetchImpl } = fakeFetch(() => json(200, {}));
    const api = new ApiClient({ baseUrl: API, fetch: fetchImpl, isBrowser: () => false });
    await expect(api.get("/v1/tasks")).rejects.toBeInstanceOf(ServerSideApiCallError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["https://evil.test/v1/x", "//evil.test/v1/x", "v1/tasks", "/\\evil.test"])(
    "refuses paths that could leave the API origin: %s",
    async (path) => {
      const { api, calls } = client(() => json(200, {}));
      await expect(api.get(path)).rejects.toBeInstanceOf(TypeError);
      expect(calls).toHaveLength(0);
    },
  );

  it("rejects idempotency keys on GET and empty keys", async () => {
    const { api } = client(() => json(200, { token: "t" }));
    await expect(api.get("/v1/x", { idempotencyKey: "k" })).rejects.toBeInstanceOf(TypeError);
    await expect(api.post("/v1/x", { idempotencyKey: " " })).rejects.toBeInstanceOf(TypeError);
  });

  it.each(["not a url", "ftp://api.symplist.test", "javascript:alert(1)"])(
    "rejects an invalid API origin: %s",
    (baseUrl) => {
      expect(() => new ApiClient({ baseUrl })).toThrow(ApiConfigurationError);
    },
  );

  it("parses public origins defensively", () => {
    expect(
      parsePublicOrigins({
        NEXT_PUBLIC_API_URL: "https://api.symplist.test/some/path",
        NEXT_PUBLIC_WS_URL: "wss://api.symplist.test",
        NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
      }),
    ).toEqual({
      apiOrigin: "https://api.symplist.test",
      wsOrigin: "wss://api.symplist.test",
      posthogHost: "https://us.i.posthog.com",
    });
    expect(
      parsePublicOrigins({
        NEXT_PUBLIC_API_URL: "https://user:pass@api.test",
        NEXT_PUBLIC_WS_URL: "https://api.test",
        NEXT_PUBLIC_POSTHOG_HOST: "http://insecure.test",
      }),
    ).toEqual({ apiOrigin: null, wsOrigin: null, posthogHost: null });
    expect(parsePublicOrigins({})).toEqual({ apiOrigin: null, wsOrigin: null, posthogHost: null });
  });
});

describe("the shared client's transport", () => {
  afterEach(() => {
    resetApiClientForTests();
    delete (globalThis as { symplist?: unknown }).symplist;
  });

  it("uses the configured public origin and the global fetch in a browser", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", API);
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetchImpl);
    await getApiClient().get("/v1/tasks");
    expect(calls[0]?.url).toBe(`${API}/v1/tasks`);
    expect(calls[0]?.init).toMatchObject({ credentials: "include", mode: "cors" });
  });

  it("refuses to build a client when no API origin is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    expect(() => getApiClient()).toThrow(ApiConfigurationError);
  });

  it("uses the desktop shell's transport and origin when the bridge is present", async () => {
    // In the desktop app every /v1 call is made by the Electron main process, which holds the session
    // cookie and sets the Origin header the api demands. The renderer has no network reach of its own.
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://wrong.test");
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const bridge = fakeBridge(() => shellResponse(200, { ok: true }));
    (globalThis as { symplist?: unknown }).symplist = {
      cloud: { apiOrigin: API, fetch: bridge.fetchImpl },
    };
    await getApiClient().get("/v1/tasks");
    expect(bridge.urls[0]).toBe(`${API}/v1/tasks`);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("hands the desktop transport a string, never a URL object", async () => {
    // The bridge function is published through Electron's `contextBridge`, so its arguments are cloned
    // between worlds by copying own enumerable properties. A `URL` has none and does not survive: it
    // arrives as an empty object, `new Request({})` resolves "[object Object]" against the renderer's
    // 127.0.0.1 origin, and main refuses every call for a bad origin. `String(input)` inside a test
    // helper hides this completely, so the argument's own type is what gets asserted.
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const bridge = fakeBridge(() => shellResponse(200, { ok: true }));
    (globalThis as { symplist?: unknown }).symplist = {
      cloud: { apiOrigin: API, fetch: bridge.fetchImpl },
    };
    await getApiClient().get("/v1/tasks", { query: { collection: "now" } });
    expect(typeof bridge.urls[0]).toBe("string");
    expect(bridge.urls[0]).toBe(`${API}/v1/tasks?collection=now`);
  });

  it("hands the desktop transport plain headers, never a Headers object", async () => {
    // The same trap as the URL, and it was missed. `ApiClient` builds a `Headers`, which has no own
    // enumerable properties, so it crossed `contextBridge` as `{}`: main received no `Content-Type`
    // and no `X-Symplist-CSRF`, every `pre_session` route answered 403, and because the renderer
    // never made an HTTP request the Network tab stayed empty and the page could only say
    // "Something went wrong". Asserting the argument's own type is the only way to see it.
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const bridge = fakeBridge(() => shellResponse(200, { ok: true }));
    (globalThis as { symplist?: unknown }).symplist = {
      cloud: { apiOrigin: API, fetch: bridge.fetchImpl },
    };
    await getApiClient().post("/v1/auth/lookup", {
      body: { email: "maya@example.com" },
      csrf: "pre_session",
    });
    const headers = bridge.inits[0]?.headers;
    expect(headers).not.toBeInstanceOf(Headers);
    expect(Object.entries(headers as Record<string, string>).length).toBeGreaterThan(0);
    const lower = Object.fromEntries(
      Object.entries(headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(lower["x-symplist-csrf"]).toBe("1");
    expect(lower["content-type"]).toBe("application/json");
  });

  it("rebuilds a real Response from the shell's plain answer", async () => {
    // The mirror of the argument problem, and the more damaging half: a `Response` constructed in the
    // preload reaches the page with no `status`, no headers and no `json()`, so `response.ok` is
    // undefined and every call fails while looking like a protocol error. The shell therefore sends
    // plain data and the client reassembles it — which has to produce something `ApiClient` can read a
    // status, a header and a parsed body from.
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const bridge = fakeBridge(() =>
      shellResponse(429, envelope("rate.limited"), { "Retry-After": "12" }),
    );
    (globalThis as { symplist?: unknown }).symplist = {
      cloud: { apiOrigin: API, fetch: bridge.fetchImpl },
    };
    const failure = await getApiClient()
      .get("/v1/tasks")
      .catch((error: unknown) => error);
    expect(isApiError(failure)).toBe(true);
    expect((failure as ApiError).status).toBe(429);
    expect((failure as ApiError).retryAfterSeconds).toBe(12);
  });

  it("rebuilds a bodyless status without throwing", async () => {
    // `new Response(body, { status: 204 })` throws unless the body is null, and a 204 is the ordinary
    // answer to a DELETE, so getting this wrong would break deletes alone and nothing else.
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    // A DELETE fetches a CSRF token first, over this same transport, so the fake has to answer both.
    const bridge = fakeBridge((url) =>
      url.endsWith(CSRF_TOKEN_PATH)
        ? shellResponse(200, { token: "csrf-token" })
        : { status: 204, headers: [], body: "" },
    );
    (globalThis as { symplist?: unknown }).symplist = {
      cloud: { apiOrigin: API, fetch: bridge.fetchImpl },
    };
    await expect(getApiClient().delete("/v1/tasks/t1")).resolves.toBeUndefined();
  });

  it("falls back to the public origin when the bridge is not a usable transport", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    for (const cloud of [null, {}, { apiOrigin: API }, { apiOrigin: "", fetch: () => undefined }]) {
      resetApiClientForTests();
      (globalThis as { symplist?: unknown }).symplist = { cloud };
      expect(() => getApiClient()).toThrow(ApiConfigurationError);
    }
  });
});

describe("idempotency keys", () => {
  it("creates unique keys", () => {
    const keys = new Set(Array.from({ length: 50 }, () => createIdempotencyKey()));
    expect(keys.size).toBe(50);
  });

  it("reuses a key for retries of one operation and issues a new one after release", () => {
    const keys = new IdempotencyKeys();
    const first = keys.acquire("create-task:now");
    expect(keys.acquire("create-task:now")).toBe(first);
    expect(keys.acquire("create-task:later")).not.toBe(first);
    keys.release("create-task:now");
    expect(keys.has("create-task:now")).toBe(false);
    expect(keys.acquire("create-task:now")).not.toBe(first);
  });

  it("requires a secure random source", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => createIdempotencyKey()).toThrow();
  });
});
