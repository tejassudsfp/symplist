import { describe, expect, it } from "vitest";
import { silentMainLog } from "../log.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import type { CloudHttp, CloudRequest, CloudResponse } from "./http.ts";
import {
  MCP_GRANT_RENEW_WITHIN_MS,
  MCP_GRANT_SECRET_NAME,
  McpGrantStore,
  parseMintResult,
  parseStoredGrant,
} from "./mcp-grant.ts";

const API = "https://api.symplist.test";
const NOW = 1_700_000_000_000;
const EXPIRES = NOW + 30 * 86_400_000;

function fakeStore(initial?: string, writable = true) {
  const entries = new Map<string, string>();
  if (initial !== undefined) entries.set(MCP_GRANT_SECRET_NAME, initial);
  return {
    entries,
    isAvailable: () => writable,
    read: (name: string) => entries.get(name) ?? null,
    write: (name: string, value: string) => {
      if (!writable) return false;
      entries.set(name, value);
      return true;
    },
    clear: (name: string) => {
      entries.delete(name);
    },
    pathFor: (name: string) => `/userData/secrets/${name}.enc`,
  } as unknown as SecretStore & { entries: Map<string, string> };
}

function grantBlob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    apiOrigin: API,
    grantId: "g_1",
    key: "mcpkey_secret",
    expiresAt: EXPIRES,
    ...overrides,
  });
}

function harness(options: {
  stored?: string;
  writable?: boolean;
  answer: (request: CloudRequest) => CloudResponse;
}) {
  const store = fakeStore(options.stored, options.writable ?? true);
  const requests: CloudRequest[] = [];
  const http: CloudHttp = async (request) => {
    requests.push(request);
    return options.answer(request);
  };
  const grants = new McpGrantStore({
    apiOrigin: API,
    http,
    store,
    log: silentMainLog,
    now: () => NOW,
    newIdempotencyKey: () => "0123456789abcdef0123",
  });
  return { grants, store, requests };
}

const csrf: CloudResponse = {
  status: 200,
  headers: [],
  body: JSON.stringify({ token: "csrf-tok" }),
};

function routed(handlers: Record<string, CloudResponse>) {
  return (request: CloudRequest): CloudResponse => {
    const key = `${request.method} ${request.path}`;
    const answer = handlers[key];
    if (!answer) throw new Error(`unexpected request: ${key}`);
    return answer;
  };
}

describe("parsing a stored grant", () => {
  it("accepts a live grant for this cloud", () => {
    expect(parseStoredGrant(grantBlob(), API, NOW)).toEqual({
      version: 1,
      apiOrigin: API,
      grantId: "g_1",
      key: "mcpkey_secret",
      expiresAt: EXPIRES,
    });
  });

  it("refuses another cloud, another version, an expired grant and anything malformed", () => {
    expect(parseStoredGrant(grantBlob({ apiOrigin: "https://other.test" }), API, NOW)).toBeNull();
    expect(parseStoredGrant(grantBlob({ version: 2 }), API, NOW)).toBeNull();
    expect(parseStoredGrant(grantBlob({ expiresAt: NOW - 1 }), API, NOW)).toBeNull();
    expect(parseStoredGrant(grantBlob({ key: "" }), API, NOW)).toBeNull();
    expect(parseStoredGrant("{", API, NOW)).toBeNull();
  });
});

describe("parsing a mint", () => {
  it("reads the id, the one-time key and the expiry", () => {
    expect(
      parseMintResult(
        JSON.stringify({ id: "g_2", key: "k", expiresAt: EXPIRES, secretUnavailable: false }),
      ),
    ).toEqual({ id: "g_2", key: "k", expiresAt: EXPIRES });
  });

  it("reports no key when the api withheld it", () => {
    // `secretUnavailable`, or the `secret.already_issued` notice on an exact retry.
    expect(
      parseMintResult(JSON.stringify({ id: "g_2", expiresAt: EXPIRES, secretUnavailable: true })),
    ).toEqual({ id: "g_2", key: null, expiresAt: EXPIRES });
  });
});

describe("holding the device's MCP grant", () => {
  const identity = { destination: "app", accessGeneration: 1 };

  it("mints a grant with the whole task scope and stores the key", async () => {
    const h = harness({
      answer: routed({
        "GET /v1/auth/csrf": csrf,
        "POST /v1/mcp/grants": {
          status: 200,
          headers: [],
          body: JSON.stringify({ id: "g_9", key: "mcpkey_live", expiresAt: EXPIRES }),
        },
      }),
    });
    await h.grants.established(identity);
    const mint = h.requests.find((request) => request.path === "/v1/mcp/grants");
    expect(JSON.parse(mint?.body ?? "")).toEqual({
      name: "Symplist for macOS",
      scopes: ["tasks:read", "tasks:write"],
      taskIds: null,
    });
    // The api requires the session-bound token on this class, and an Idempotency-Key on the mutation.
    expect(mint?.headers).toContainEqual(["X-Symplist-CSRF", "csrf-tok"]);
    expect(mint?.headers).toContainEqual(["Idempotency-Key", "0123456789abcdef0123"]);
    expect(h.grants.current()?.key).toBe("mcpkey_live");
  });

  it("keeps a grant that has plenty of life left rather than minting another", async () => {
    const h = harness({ stored: grantBlob(), answer: routed({}) });
    await h.grants.established(identity);
    expect(h.requests).toHaveLength(0);
    expect(h.grants.current()?.grantId).toBe("g_1");
  });

  it("replaces a grant that is about to expire, revoking the old one first", async () => {
    const h = harness({
      stored: grantBlob({ expiresAt: NOW + MCP_GRANT_RENEW_WITHIN_MS - 1 }),
      answer: routed({
        "GET /v1/auth/csrf": csrf,
        "DELETE /v1/mcp/grants/g_1": { status: 200, headers: [], body: "{}" },
        "POST /v1/mcp/grants": {
          status: 200,
          headers: [],
          body: JSON.stringify({ id: "g_2", key: "second", expiresAt: EXPIRES }),
        },
      }),
    });
    await h.grants.established(identity);
    expect(h.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /v1/auth/csrf",
      "DELETE /v1/mcp/grants/g_1",
      "POST /v1/mcp/grants",
    ]);
    expect(h.grants.current()?.grantId).toBe("g_2");
  });

  it("revokes a grant it cannot store, rather than leaving a live key it cannot name", async () => {
    const h = harness({
      writable: false,
      answer: routed({
        "GET /v1/auth/csrf": csrf,
        "POST /v1/mcp/grants": {
          status: 200,
          headers: [],
          body: JSON.stringify({ id: "g_3", key: "orphan", expiresAt: EXPIRES }),
        },
        "DELETE /v1/mcp/grants/g_3": { status: 200, headers: [], body: "{}" },
      }),
    });
    await h.grants.established(identity);
    expect(h.requests.map((request) => request.path)).toContain("/v1/mcp/grants/g_3");
    expect(h.grants.current()).toBeNull();
  });

  it("revokes a mint that carried no key, since it cannot be used", async () => {
    const h = harness({
      answer: routed({
        "GET /v1/auth/csrf": csrf,
        "POST /v1/mcp/grants": {
          status: 200,
          headers: [],
          body: JSON.stringify({ id: "g_4", expiresAt: EXPIRES, secretUnavailable: true }),
        },
        "DELETE /v1/mcp/grants/g_4": { status: 200, headers: [], body: "{}" },
      }),
    });
    await h.grants.established(identity);
    expect(h.grants.current()).toBeNull();
  });

  it("revokes before sign-out, while the session still authorizes it", async () => {
    const h = harness({
      stored: grantBlob(),
      answer: routed({
        "GET /v1/auth/csrf": csrf,
        "DELETE /v1/mcp/grants/g_1": { status: 200, headers: [], body: "{}" },
      }),
    });
    await h.grants.beforeSignOut();
    expect(h.grants.lastRevoke()).toBe("revoked");
    expect(h.store.entries.has(MCP_GRANT_SECRET_NAME)).toBe(false);
  });

  it("says plainly when an offline sign-out left the key live at the api", async () => {
    const h = harness({
      stored: grantBlob(),
      answer: () => {
        throw new TypeError("fetch failed");
      },
    });
    await h.grants.beforeSignOut();
    // The local copy goes regardless — a key we cannot revoke is still a key we must not keep — but the
    // app must not claim a clean sign-out.
    expect(h.grants.lastRevoke()).toBe("failed");
    expect(h.store.entries.has(MCP_GRANT_SECRET_NAME)).toBe(false);
  });

  it("counts a grant that is already gone as released", async () => {
    const h = harness({
      stored: grantBlob(),
      answer: routed({
        "GET /v1/auth/csrf": csrf,
        "DELETE /v1/mcp/grants/g_1": {
          status: 404,
          headers: [],
          body: JSON.stringify({ error: { code: "mcp.grant_not_found", requestId: "r" } }),
        },
      }),
    });
    await h.grants.beforeSignOut();
    expect(h.grants.lastRevoke()).toBe("revoked");
  });

  it("reports nothing to release when the device holds no grant", async () => {
    const h = harness({ answer: routed({}) });
    await h.grants.beforeSignOut();
    expect(h.grants.lastRevoke()).toBe("not_held");
    expect(h.requests).toHaveLength(0);
  });

  it("refetches the CSRF token once when the api rejects the one it had", async () => {
    let tokens = 0;
    let mints = 0;
    const h = harness({
      answer: (request) => {
        if (request.path === "/v1/auth/csrf") {
          tokens += 1;
          return { status: 200, headers: [], body: JSON.stringify({ token: `tok-${tokens}` }) };
        }
        mints += 1;
        if (mints === 1) {
          return {
            status: 403,
            headers: [],
            body: JSON.stringify({ error: { code: "auth.csrf_invalid", requestId: "r" } }),
          };
        }
        return {
          status: 200,
          headers: [],
          body: JSON.stringify({ id: "g_5", key: "after-retry", expiresAt: EXPIRES }),
        };
      },
    });
    await h.grants.established(identity);
    expect(tokens).toBe(2);
    expect(h.grants.current()?.key).toBe("after-retry");
  });

  it("drops the local copy when the session is cleared", async () => {
    const h = harness({ stored: grantBlob(), answer: routed({}) });
    await h.grants.cleared();
    expect(h.store.entries.has(MCP_GRANT_SECRET_NAME)).toBe(false);
  });

  it("forgets a stored grant that has expired", async () => {
    const h = harness({ stored: grantBlob({ expiresAt: NOW - 1 }), answer: routed({}) });
    expect(h.grants.current()).toBeNull();
    expect(h.store.entries.has(MCP_GRANT_SECRET_NAME)).toBe(false);
  });
});
