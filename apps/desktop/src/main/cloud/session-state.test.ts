import { describe, expect, it, vi } from "vitest";
import { silentMainLog } from "../log.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import { CookieJar } from "./cookie-jar.ts";
import type { CloudHttp, CloudRequest, CloudResponse } from "./http.ts";
import {
  CloudSession,
  errorCodeOf,
  identityOf,
  parsePersistedSession,
  SESSION_BLOB_VERSION,
  SESSION_SECRET_NAME,
} from "./session-state.ts";

const API = "https://api.symplist.test";
const NOW = 1_700_000_000_000;

/** A secret store backed by a map, so the transitions are observable without a filesystem. */
function fakeStore(initial?: string): SecretStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  if (initial !== undefined) entries.set(SESSION_SECRET_NAME, initial);
  return {
    entries,
    isAvailable: () => true,
    read: (name: string) => entries.get(name) ?? null,
    write: (name: string, value: string) => {
      entries.set(name, value);
      return true;
    },
    clear: (name: string) => {
      entries.delete(name);
    },
    pathFor: (name: string) => `/userData/secrets/${name}.enc`,
  } as unknown as SecretStore & { entries: Map<string, string> };
}

function me(destination: string, accessGeneration = 1): string {
  return JSON.stringify({ destination, access: { accessGeneration }, user: { id: "u_1" } });
}

const sessionRequired = JSON.stringify({
  error: { code: "auth.session_required", message: "Sign in", requestId: "req_1" },
});

function blob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: SESSION_BLOB_VERSION,
    apiOrigin: API,
    cookieName: "__Host-sym_session",
    cookieValue: "tok",
    expiresAt: NOW + 86_400_000,
    ...overrides,
  });
}

interface Harness {
  readonly session: CloudSession;
  readonly jar: CookieJar;
  readonly store: SecretStore & { entries: Map<string, string> };
  readonly requests: CloudRequest[];
  readonly ended: () => number;
}

function harness(options: {
  stored?: string;
  answer?: (request: CloudRequest) => CloudResponse | Promise<CloudResponse>;
}): Harness {
  const jar = new CookieJar(() => NOW);
  const store = fakeStore(options.stored);
  const requests: CloudRequest[] = [];
  let ended = 0;
  const http: CloudHttp = async (request) => {
    requests.push(request);
    const answer = options.answer?.(request);
    if (answer) return await answer;
    return { status: 200, headers: [], body: me("app") };
  };
  const session = new CloudSession({
    apiOrigin: API,
    jar,
    store,
    http,
    log: silentMainLog,
    now: () => NOW,
    restoreTimeoutMs: 25,
    onSessionEnded: () => {
      ended += 1;
    },
  });
  return { session, jar, store, requests, ended: () => ended };
}

describe("parsing a persisted session", () => {
  it("accepts a blob for this cloud that has not expired", () => {
    expect(parsePersistedSession(blob(), API, NOW)).toEqual({
      version: SESSION_BLOB_VERSION,
      apiOrigin: API,
      cookieName: "__Host-sym_session",
      cookieValue: "tok",
      expiresAt: NOW + 86_400_000,
    });
  });

  it("refuses another cloud, another version, an expired cookie and anything malformed", () => {
    expect(parsePersistedSession(blob({ apiOrigin: "https://other.test" }), API, NOW)).toBeNull();
    expect(parsePersistedSession(blob({ version: 99 }), API, NOW)).toBeNull();
    expect(parsePersistedSession(blob({ expiresAt: NOW - 1 }), API, NOW)).toBeNull();
    expect(parsePersistedSession(blob({ cookieValue: "" }), API, NOW)).toBeNull();
    expect(parsePersistedSession(blob({ cookieName: 4 }), API, NOW)).toBeNull();
    expect(parsePersistedSession("not json", API, NOW)).toBeNull();
    expect(parsePersistedSession("null", API, NOW)).toBeNull();
  });

  it("accepts a cookie with no expiry of its own", () => {
    expect(parsePersistedSession(blob({ expiresAt: null }), API, NOW)?.expiresAt).toBeNull();
  });
});

describe("reading an api answer", () => {
  it("finds the error code in the envelope", () => {
    expect(errorCodeOf(sessionRequired)).toBe("auth.session_required");
    expect(errorCodeOf("{}")).toBeNull();
    expect(errorCodeOf("<html>")).toBeNull();
  });

  it("reads only the destination and the access generation from an identity", () => {
    expect(identityOf(me("onboarding", 7))).toEqual({
      destination: "onboarding",
      accessGeneration: 7,
    });
    expect(identityOf(JSON.stringify({ destination: "app" }))).toBeNull();
  });

  it("reads the identity nested under `me`, which is how beta unlock answers", () => {
    // POST /v1/access/redeem returns { outcome, me } — and that is the moment an account becomes
    // admitted, so missing it would put off provisioning the MCP grant until the next GET /v1/me.
    expect(
      identityOf(JSON.stringify({ outcome: "unlocked", me: JSON.parse(me("app", 3)) })),
    ).toEqual({ destination: "app", accessGeneration: 3 });
  });
});

describe("restoring a session on launch", () => {
  it("reports signed out when nothing is stored, and asks the api nothing", async () => {
    const h = harness({});
    await expect(h.session.restore()).resolves.toBe("signed_out");
    expect(h.requests).toHaveLength(0);
  });

  it("confirms a stored session with one GET /v1/me", async () => {
    const h = harness({ stored: blob() });
    await expect(h.session.restore()).resolves.toBe("restored");
    expect(h.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /v1/me",
    ]);
    expect(h.jar.header()).toBe("__Host-sym_session=tok");
    expect(h.session.currentIdentity()?.destination).toBe("app");
  });

  it("discards a blob from another cloud without asking the api", async () => {
    const h = harness({ stored: blob({ apiOrigin: "https://other.test" }) });
    await expect(h.session.restore()).resolves.toBe("signed_out");
    expect(h.requests).toHaveLength(0);
    expect(h.store.entries.has(SESSION_SECRET_NAME)).toBe(false);
  });

  it("deletes the blob when the api says the session resolves to nothing", async () => {
    const h = harness({
      stored: blob(),
      answer: () => ({ status: 401, headers: [], body: sessionRequired }),
    });
    await expect(h.session.restore()).resolves.toBe("signed_out");
    // Otherwise every launch would retry a dead token.
    expect(h.store.entries.has(SESSION_SECRET_NAME)).toBe(false);
    expect(h.jar.header()).toBeNull();
    // Nothing to tell the renderer: it has not rendered yet, and it will see a signed-out api.
    expect(h.ended()).toBe(0);
  });

  it("keeps the session when the api cannot be reached", async () => {
    const h = harness({
      stored: blob(),
      answer: () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(h.session.restore()).resolves.toBe("unreachable");
    expect(h.store.entries.get(SESSION_SECRET_NAME)).toBe(blob());
    expect(h.jar.header()).toBe("__Host-sym_session=tok");
  });

  it("gives up on an api that never answers, rather than holding the window on a blank screen", async () => {
    const h = harness({
      stored: blob(),
      answer: (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("TimeoutError")));
        }),
    });
    await expect(h.session.restore()).resolves.toBe("unreachable");
    expect(h.store.entries.has(SESSION_SECRET_NAME)).toBe(true);
  });

  it("keeps the session when the api answers something that is not about this session", async () => {
    const h = harness({
      stored: blob(),
      answer: () => ({ status: 503, headers: [], body: "" }),
    });
    await expect(h.session.restore()).resolves.toBe("unreachable");
    expect(h.store.entries.has(SESSION_SECRET_NAME)).toBe(true);
  });
});

describe("observing the sign-in traffic the renderer produces", () => {
  it("persists the session the api created on a verified code", async () => {
    const h = harness({});
    h.jar.acceptSetCookies(["__Host-sym_session=fresh; Max-Age=600"]);
    await h.session.afterResponse("POST", "/v1/auth/otp/verify", {
      status: 200,
      headers: [],
      body: me("app"),
    });
    const stored = h.store.entries.get(SESSION_SECRET_NAME);
    expect(stored).toBeDefined();
    expect(JSON.parse(stored ?? "")).toMatchObject({
      apiOrigin: API,
      cookieName: "__Host-sym_session",
      cookieValue: "fresh",
    });
  });

  it("never persists the vault cookie, so a restart cannot leave a vault unlocked", async () => {
    const h = harness({});
    h.jar.acceptSetCookies([
      "__Host-sym_session=fresh; Max-Age=600",
      "sym_vault=unlocked; Max-Age=3600",
    ]);
    await h.session.afterResponse("POST", "/v1/auth/otp/verify", {
      status: 200,
      headers: [],
      body: me("app"),
    });
    expect(h.store.entries.get(SESSION_SECRET_NAME)).not.toContain("unlocked");
  });

  it("clears everything when the api answers auth.session_required, and tells the renderer", async () => {
    const h = harness({ stored: blob() });
    await h.session.restore();
    await h.session.afterResponse("GET", "/v1/tasks", {
      status: 401,
      headers: [],
      body: sessionRequired,
    });
    expect(h.store.entries.has(SESSION_SECRET_NAME)).toBe(false);
    expect(h.jar.header()).toBeNull();
    expect(h.ended()).toBe(1);
  });

  it("leaves a signed-out app alone on a 401 it was expecting", async () => {
    const h = harness({});
    await h.session.afterResponse("GET", "/v1/me", {
      status: 401,
      headers: [],
      body: sessionRequired,
    });
    // The web app reads GET /v1/me before showing sign-in; that 401 is not an event.
    expect(h.ended()).toBe(0);
  });

  it("does not treat an access denial as the session ending", async () => {
    const h = harness({ stored: blob() });
    await h.session.restore();
    await h.session.afterResponse("GET", "/v1/tasks", {
      status: 403,
      headers: [],
      body: JSON.stringify({ error: { code: "access.suspended", requestId: "r" } }),
    });
    expect(h.store.entries.has(SESSION_SECRET_NAME)).toBe(true);
    expect(h.ended()).toBe(0);
  });

  it("keeps the session when a sign-out did not succeed", async () => {
    const h = harness({ stored: blob() });
    await h.session.restore();
    await h.session.afterResponse("POST", "/v1/auth/logout", {
      status: 503,
      headers: [],
      body: "",
    });
    // signOut() in apps/web refuses to claim a sign-out that did not happen; this matches it.
    expect(h.store.entries.has(SESSION_SECRET_NAME)).toBe(true);
  });

  it("matches the sign-out and verify routes by path, ignoring a query string", async () => {
    const h = harness({});
    h.jar.acceptSetCookies(["sym_session=fresh; Max-Age=600"]);
    await h.session.afterResponse("POST", "/v1/auth/otp/verify?x=1", {
      status: 200,
      headers: [],
      body: me("app"),
    });
    expect(h.store.entries.has(SESSION_SECRET_NAME)).toBe(true);
  });

  it("reports when the session could not be persisted rather than writing it in the clear", async () => {
    const h = harness({});
    const write = vi.spyOn(h.store, "write").mockReturnValue(false);
    h.jar.acceptSetCookies(["sym_session=fresh; Max-Age=600"]);
    await h.session.afterResponse("POST", "/v1/auth/otp/verify", {
      status: 200,
      headers: [],
      body: me("app"),
    });
    expect(write).toHaveBeenCalledOnce();
    expect(h.store.entries.has(SESSION_SECRET_NAME)).toBe(false);
  });
});
