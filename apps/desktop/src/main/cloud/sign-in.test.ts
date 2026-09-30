// @vitest-environment node
/**
 * Sign-in end to end, through every piece the desktop actually uses: the IPC handler's pinning, the
 * outbound client with its `Origin` header, Node's own `fetch` and `Headers.getSetCookie()`, the two-tier
 * jar, and the encrypted store — then again after a simulated restart, from nothing but the stored blob.
 *
 * The server below is not a mock of our client; it is a small enforcer of the api's real rules, written
 * from `apps/api/src/common/guards/route-class.guard.ts` and `access.guard.ts`: `pre_session` routes
 * demand `Origin === WEB_ORIGIN` on every method plus the literal `X-Symplist-CSRF: 1`; `app` routes
 * demand the session cookie and, on unsafe methods, the session-bound token from `GET /v1/auth/csrf`;
 * mutations with side effects demand an `Idempotency-Key`. Every one of those is a 4xx here, so a client
 * that stopped sending one would fail this test rather than pass it quietly.
 *
 * What it does not prove is that the deployed api agrees with this reading — only a run against a live
 * api does that, and the `Origin` rule was confirmed against one by hand (a `POST /v1/auth/lookup`
 * answers 200 with the header and `auth.origin_forbidden` without it).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentMainLog } from "../log.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import { CookieJar } from "./cookie-jar.ts";
import { createCloudHttp } from "./http.ts";
import { createCloudHandlers } from "./ipc.ts";
import { CloudSession } from "./session-state.ts";

const WEB_ORIGIN = "https://app.symplist.test";
/** The production cookie name, so the test proves the jar takes what arrives rather than a guess. */
const SESSION_COOKIE = "__Host-sym_session";
const OTP_CODE = "123456";

interface FakeApi {
  readonly origin: string;
  readonly close: () => Promise<void>;
  /** Sessions the api considers live, by token. Revoking one here is another device signing this out. */
  readonly sessions: Set<string>;
  readonly grants: Set<string>;
  readonly requests: string[];
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function startFakeApi(): Promise<FakeApi> {
  const sessions = new Set<string>();
  const grants = new Set<string>();
  const requests: string[] = [];
  let nextToken = 0;
  let nextGrant = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      requests.push(`${method} ${path}`);
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      const send = (status: number, body: unknown, cookies: string[] = []): void => {
        response.writeHead(status, {
          "content-type": "application/json",
          "x-request-id": "req_test",
          ...(cookies.length > 0 ? { "set-cookie": cookies } : {}),
        });
        response.end(JSON.stringify(body));
      };
      const fail = (status: number, code: string): void => {
        send(status, { error: { code, message: "refused", requestId: "req_test" } });
      };
      const sessionToken = (): string | null => {
        const cookie = header("cookie") ?? "";
        for (const pair of cookie.split(";")) {
          const [name, ...rest] = pair.trim().split("=");
          if (name === SESSION_COOKIE) return rest.join("=");
        }
        return null;
      };
      const me = (destination: string) => ({
        user: { id: "u_test", role: "member" },
        destination,
        access: { accessGeneration: 1, betaState: "unlocked", onboardingStep: "done" },
      });

      // --- pre_session: Origin must equal WEB_ORIGIN on every method, plus the literal CSRF header ---
      if (path.startsWith("/v1/auth/") && path !== "/v1/auth/csrf" && path !== "/v1/auth/logout") {
        if (header("origin") !== WEB_ORIGIN) return fail(403, "auth.origin_forbidden");
        if (header("x-symplist-csrf") !== "1") return fail(403, "auth.csrf_invalid");
        const body = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
        if (path === "/v1/auth/lookup") return send(200, { exists: true });
        if (path === "/v1/auth/otp") return send(201, { challengeId: "ch_1", expiresAt: 0 });
        if (path === "/v1/auth/otp/verify") {
          if (body.code !== OTP_CODE) return fail(400, "auth.code_invalid");
          nextToken += 1;
          const token = `tok_${nextToken}`;
          sessions.add(token);
          return send(200, me("app"), [
            `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
            "sym_hint=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000",
          ]);
        }
        return fail(404, "not_found");
      }

      // --- app: the session cookie is the only credential, and unsafe methods need its token ---
      const token = sessionToken();
      if (token === null || !sessions.has(token)) return fail(401, "auth.session_required");
      const unsafe = method !== "GET" && method !== "HEAD";
      if (unsafe) {
        if (header("origin") !== WEB_ORIGIN) return fail(403, "auth.origin_forbidden");
        if (header("x-symplist-csrf") !== `csrf-${token}`) return fail(403, "auth.csrf_invalid");
      }

      if (path === "/v1/me") return send(200, me("app"));
      if (path === "/v1/auth/csrf") return send(200, { token: `csrf-${token}` });
      if (path === "/v1/auth/logout") {
        sessions.delete(token);
        return send(200, { signedOut: true }, [
          `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
        ]);
      }
      if (path === "/v1/vault/unlock") {
        return send(200, { unlocked: true }, [
          "__Host-sym_vault=vault-tok; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600",
        ]);
      }
      if (path === "/v1/mcp/grants" && method === "POST") {
        if (header("idempotency-key") === undefined) return fail(400, "idempotency.key_required");
        nextGrant += 1;
        const id = `g_${nextGrant}`;
        grants.add(id);
        return send(200, {
          id,
          key: `mcpkey_${id}`,
          expiresAt: Date.now() + 30 * 86_400_000,
          secretUnavailable: false,
        });
      }
      if (path.startsWith("/v1/mcp/grants/") && method === "DELETE") {
        if (header("idempotency-key") === undefined) return fail(400, "idempotency.key_required");
        const id = path.slice("/v1/mcp/grants/".length);
        if (!grants.delete(id)) return fail(404, "mcp.grant_not_found");
        return send(200, { revoked: true });
      }
      return fail(404, "not_found");
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    sessions,
    grants,
    requests,
  };
}

/** A secret store whose map survives a "restart", standing in for the keychain-backed files. */
function persistentStore(entries: Map<string, string>): SecretStore {
  return {
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
  } as unknown as SecretStore;
}

/** One launch of the app: a fresh jar and a fresh session over the same stored secrets. */
function launch(apiOrigin: string, entries: Map<string, string>) {
  const jar = new CookieJar();
  const store = persistentStore(entries);
  const http = createCloudHttp({ apiOrigin, webOrigin: WEB_ORIGIN, jar, log: silentMainLog });
  let ended = 0;
  const session = new CloudSession({
    apiOrigin,
    jar,
    store,
    http,
    log: silentMainLog,
    onSessionEnded: () => {
      ended += 1;
    },
  });
  const handlers = createCloudHandlers({ apiOrigin, http, session, log: silentMainLog });

  /** What the renderer's ApiClient produces for one call, as plain IPC data. */
  let id = 0;
  const call = async (
    method: string,
    path: string,
    options: { csrf?: string; body?: unknown; idempotencyKey?: string } = {},
  ) => {
    const headers: [string, string][] = [["Accept", "application/json"]];
    if (options.csrf !== undefined) headers.push(["X-Symplist-CSRF", options.csrf]);
    if (options.idempotencyKey !== undefined) {
      headers.push(["Idempotency-Key", options.idempotencyKey]);
    }
    if (options.body !== undefined) headers.push(["Content-Type", "application/json"]);
    id += 1;
    return await handlers.request({
      requestId: `r${id}`,
      method,
      url: `${apiOrigin}${path}`,
      headers,
      body: options.body === undefined ? null : JSON.stringify(options.body),
    });
  };

  /** The `app` route class needs the session-bound token, exactly as ApiClient fetches it. */
  const csrfToken = async (): Promise<string> => {
    const answer = await call("GET", "/v1/auth/csrf");
    return (JSON.parse(answer.body) as { token: string }).token;
  };

  return { jar, session, handlers, call, csrfToken, ended: () => ended };
}

describe("signing in to the cloud from the desktop", () => {
  let api: FakeApi;
  beforeEach(async () => {
    api = await startFakeApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it("runs the email-code flow, keeps the session, and survives a restart", async () => {
    const secrets = new Map<string, string>();
    const first = launch(api.origin, secrets);
    await expect(first.session.restore()).resolves.toBe("signed_out");

    // The web app's own sign-in screens produce exactly these three calls.
    expect(
      (await first.call("POST", "/v1/auth/lookup", { csrf: "1", body: { email: "a@b.test" } }))
        .status,
    ).toBe(200);
    expect(
      (await first.call("POST", "/v1/auth/otp", { csrf: "1", body: { email: "a@b.test" } })).status,
    ).toBe(201);
    const verified = await first.call("POST", "/v1/auth/otp/verify", {
      csrf: "1",
      body: { challengeId: "ch_1", code: OTP_CODE },
    });
    expect(verified.status).toBe(200);
    // The api sent Set-Cookie; the renderer never saw it.
    expect(verified.headers.map(([name]) => name.toLowerCase())).not.toContain("set-cookie");
    expect(first.jar.session()?.name).toBe(SESSION_COOKIE);
    expect(secrets.has("cloud-session")).toBe(true);

    // A restart: nothing in memory, only what was stored.
    const second = launch(api.origin, secrets);
    await expect(second.session.restore()).resolves.toBe("restored");
    expect((await second.call("GET", "/v1/me")).status).toBe(200);
    expect(second.session.currentIdentity()?.destination).toBe("app");
  });

  it("refuses the code flow if the CSRF header is dropped, which is how it would silently break", async () => {
    const app = launch(api.origin, new Map());
    const answer = await app.call("POST", "/v1/auth/lookup", { body: { email: "a@b.test" } });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "auth.csrf_invalid" } });
  });

  it("carries the session-bound token on an app mutation and clears everything on sign-out", async () => {
    const secrets = new Map<string, string>();
    const app = launch(api.origin, secrets);
    await app.call("POST", "/v1/auth/otp/verify", {
      csrf: "1",
      body: { challengeId: "ch_1", code: OTP_CODE },
    });

    const token = await app.csrfToken();
    const answer = await app.call("POST", "/v1/auth/logout", { csrf: token });
    expect(answer.status).toBe(200);
    expect(api.sessions.size).toBe(0);
    expect(secrets.size).toBe(0);
    expect(app.jar.header()).toBeNull();
    // A later request gets a 401 and does not somehow resurrect anything.
    expect((await app.call("GET", "/v1/me")).status).toBe(401);
  });

  it("never persists the vault cookie, so a restart leaves the vault locked", async () => {
    const secrets = new Map<string, string>();
    const app = launch(api.origin, secrets);
    await app.call("POST", "/v1/auth/otp/verify", {
      csrf: "1",
      body: { challengeId: "ch_1", code: OTP_CODE },
    });
    const token = await app.csrfToken();
    expect((await app.call("POST", "/v1/vault/unlock", { csrf: token })).status).toBe(200);
    expect(app.jar.header()).toContain("__Host-sym_vault=vault-tok");
    expect(secrets.get("cloud-session")).not.toContain("vault-tok");

    const restarted = launch(api.origin, secrets);
    await expect(restarted.session.restore()).resolves.toBe("restored");
    expect(restarted.jar.header()).not.toContain("sym_vault");
  });

  it("returns to sign-in when the session is revoked from somewhere else", async () => {
    const secrets = new Map<string, string>();
    const app = launch(api.origin, secrets);
    await app.call("POST", "/v1/auth/otp/verify", {
      csrf: "1",
      body: { challengeId: "ch_1", code: OTP_CODE },
    });
    // Another device signs this session out, or an admin suspends the account.
    api.sessions.clear();
    const answer = await app.call("GET", "/v1/me");
    expect(answer.status).toBe(401);
    expect(app.ended()).toBe(1);
    expect(secrets.has("cloud-session")).toBe(false);

    // And a restart does not retry the dead token.
    const restarted = launch(api.origin, secrets);
    await expect(restarted.session.restore()).resolves.toBe("signed_out");
  });

  it("discards a stored session the api refuses when the app launches", async () => {
    const secrets = new Map<string, string>();
    const app = launch(api.origin, secrets);
    await app.call("POST", "/v1/auth/otp/verify", {
      csrf: "1",
      body: { challengeId: "ch_1", code: OTP_CODE },
    });
    api.sessions.clear();
    const restarted = launch(api.origin, secrets);
    await expect(restarted.session.restore()).resolves.toBe("signed_out");
    expect(secrets.has("cloud-session")).toBe(false);
    expect(restarted.ended()).toBe(0);
  });

  it("keeps a stored session when the api is unreachable, rather than signing the user out", async () => {
    const secrets = new Map<string, string>();
    const app = launch(api.origin, secrets);
    await app.call("POST", "/v1/auth/otp/verify", {
      csrf: "1",
      body: { challengeId: "ch_1", code: OTP_CODE },
    });
    const stored = secrets.get("cloud-session");
    await api.close();

    const restarted = launch(api.origin, secrets);
    await expect(restarted.session.restore()).resolves.toBe("unreachable");
    expect(secrets.get("cloud-session")).toBe(stored);
  });

  it("refuses a request the renderer aimed outside /v1, before any cookie is attached", async () => {
    const secrets = new Map<string, string>();
    const app = launch(api.origin, secrets);
    await app.call("POST", "/v1/auth/otp/verify", {
      csrf: "1",
      body: { challengeId: "ch_1", code: OTP_CODE },
    });
    const before = api.requests.length;
    await expect(
      app.handlers.request({
        requestId: "x",
        method: "GET",
        url: `${api.origin}/oauth/token`,
        headers: [],
        body: null,
      }),
    ).rejects.toThrow();
    expect(api.requests).toHaveLength(before);
  });
});
