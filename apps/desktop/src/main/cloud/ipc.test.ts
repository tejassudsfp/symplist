import { describe, expect, it, vi } from "vitest";
import { silentMainLog } from "../log.ts";
import type { CloudHttp, CloudRequest, CloudResponse } from "./http.ts";
import { CloudRequestRefused } from "./http.ts";
import { cloudRequestDecision, createCloudHandlers } from "./ipc.ts";
import type { CloudSession } from "./session-state.ts";

const API = "https://api.symplist.test";

function harness(answer?: (request: CloudRequest) => CloudResponse | Promise<CloudResponse>) {
  const requests: CloudRequest[] = [];
  const observed: string[] = [];
  const http: CloudHttp = async (request) => {
    requests.push(request);
    return (
      (await answer?.(request)) ?? {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: "{}",
      }
    );
  };
  const session = {
    afterResponse: vi.fn(async (method: string, path: string) => {
      observed.push(`after ${method} ${path}`);
    }),
  } as unknown as CloudSession;
  return {
    handlers: createCloudHandlers({ apiOrigin: API, http, session, log: silentMainLog }),
    requests,
    observed,
    session,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "r1",
    method: "GET",
    url: `${API}/v1/me`,
    headers: [["Accept", "application/json"]],
    body: null,
    ...overrides,
  };
}

describe("pinning a request from the renderer", () => {
  it("accepts a /v1 url on the api origin and keeps its query", () => {
    expect(
      cloudRequestDecision({
        url: `${API}/v1/tasks?collection=now`,
        method: "get",
        apiOrigin: API,
      }),
    ).toEqual({ allowed: true, method: "GET", path: "/v1/tasks?collection=now" });
  });

  it("refuses another origin", () => {
    // The IPC handler holds the session cookie and takes a URL from the renderer, so this is the check
    // that stops renderer code — or a compromised dependency in the web bundle — aiming an
    // authenticated request somewhere else.
    for (const url of [
      "https://evil.test/v1/me",
      "http://api.symplist.test/v1/me",
      `${API}:8443/v1/me`,
      "https://api.symplist.test.evil.test/v1/me",
      `https://user:pass@api.symplist.test/v1/me`,
    ]) {
      expect(cloudRequestDecision({ url, method: "GET", apiOrigin: API }), url).toEqual({
        allowed: false,
        reason: "origin",
      });
    }
  });

  it("refuses a path outside /v1/, because the session cookie covers the whole api host", () => {
    for (const path of [
      "/oauth/token",
      "/internal/v1/relay",
      "/mcp",
      "/healthz",
      "/v1",
      "/v10/me",
    ]) {
      expect(
        cloudRequestDecision({ url: `${API}${path}`, method: "GET", apiOrigin: API }),
        path,
      ).toEqual({ allowed: false, reason: "path" });
    }
  });

  it("refuses traversal that only leaves /v1/ after normalisation", () => {
    expect(
      cloudRequestDecision({ url: `${API}/v1/../oauth/token`, method: "GET", apiOrigin: API }),
    ).toEqual({ allowed: false, reason: "path" });
  });

  it("refuses a method outside the five the client sends", () => {
    for (const method of ["HEAD", "OPTIONS", "TRACE", "CONNECT", ""]) {
      expect(cloudRequestDecision({ url: `${API}/v1/me`, method, apiOrigin: API }), method).toEqual(
        { allowed: false, reason: "method" },
      );
    }
  });

  it("refuses a url that is not a url", () => {
    expect(cloudRequestDecision({ url: "/v1/me", method: "GET", apiOrigin: API })).toEqual({
      allowed: false,
      reason: "url",
    });
  });
});

describe("the cloud request handler", () => {
  it("makes the request and lets the session see the answer", async () => {
    // The session reads every answer, because that is how it learns a sign-out succeeded, an account
    // moved past the beta gate, or the api revoked the session out from under the app.
    const h = harness();
    const response = await h.handlers.request(
      payload({ method: "POST", url: `${API}/v1/auth/logout`, body: null }),
    );
    expect(response.status).toBe(200);
    expect(h.observed).toEqual(["after POST /v1/auth/logout"]);
  });

  it("refuses an off-origin url before the request is made at all", async () => {
    const h = harness();
    await expect(h.handlers.request(payload({ url: "https://evil.test/v1/me" }))).rejects.toThrow(
      CloudRequestRefused,
    );
    // Nothing was sent, so no cookie was ever attached to it.
    expect(h.requests).toHaveLength(0);
    expect(h.observed).toEqual([]);
  });

  it("refuses a non-/v1 path before the request is made at all", async () => {
    const h = harness();
    await expect(
      h.handlers.request(payload({ url: `${API}/oauth/token`, method: "POST" })),
    ).rejects.toThrow(CloudRequestRefused);
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a payload that is not the shape it expects", async () => {
    const h = harness();
    for (const bad of [
      null,
      "string",
      payload({ requestId: 1 }),
      payload({ headers: "nope" }),
      payload({ headers: [["only-one"]] }),
      payload({ headers: [[1, 2]] }),
      payload({ body: 5 }),
      payload({ url: 7 }),
    ]) {
      await expect(h.handlers.request(bad)).rejects.toThrow(CloudRequestRefused);
    }
    expect(h.requests).toHaveLength(0);
  });

  it("aborts a request in flight when the renderer's signal fires", async () => {
    let seen: AbortSignal | undefined;
    const h = harness(async (request) => {
      seen = request.signal;
      return { status: 200, headers: [], body: "{}" };
    });
    const pending = h.handlers.request(payload());
    h.handlers.abort("r1");
    await pending;
    expect(seen?.aborted).toBe(true);
  });

  it("ignores an abort for a request it does not have", () => {
    const h = harness();
    expect(() => h.handlers.abort("unknown")).not.toThrow();
    expect(() => h.handlers.abort(42)).not.toThrow();
  });

  it("aborts everything in flight when the window goes away", async () => {
    const signals: AbortSignal[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(async (request) => {
      if (request.signal) signals.push(request.signal);
      await gate;
      return { status: 200, headers: [], body: "{}" };
    });
    const first = h.handlers.request(payload({ requestId: "a" }));
    const second = h.handlers.request(payload({ requestId: "b" }));
    await Promise.resolve();
    h.handlers.abortAll();
    release?.();
    await Promise.all([first, second]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
