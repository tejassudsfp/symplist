import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parsePublicOrigins } from "../public-config.ts";
import { ApiClient, CSRF_HEADER } from "./client.ts";
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
