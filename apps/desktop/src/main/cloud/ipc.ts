/**
 * The cloud capability the renderer can reach, and the pinning that makes it safe to offer.
 *
 * This handler is a confused deputy by construction: it holds the session cookie and it takes a URL from
 * a renderer that also renders user-authored Markdown and, later, runs a chat UI next to a shell. So the
 * URL is pinned twice over — `url.origin` must equal the configured api origin, and the path must begin
 * `/v1/` — and both checks happen before the jar is consulted, so a refused request never has a cookie
 * attached to it in the first place. `cloudRequestDecision` is a pure function for exactly that reason:
 * the rule that must not be loosened is the rule with its own test.
 *
 * What crosses the bridge is plain data in both directions: `{requestId, method, url, headers, body}` out,
 * `{status, headers, body}` back. `Cookie` is never accepted on the way out and `Set-Cookie` is never
 * returned on the way in, so the renderer cannot read the session token, cannot set one, and has no
 * network reach to the api at all — which is also why the desktop's CSP needs no `connect-src` for it.
 *
 * Bodies are strings. `/v1` speaks JSON and nothing else, and a string keeps the boundary to one type.
 */

import type { CloudRequestPayload, CloudResponsePayload } from "../../shared/ipc.ts";
import type { MainLog } from "../log.ts";
import { allowedMethods, type CloudHttp, CloudRequestRefused } from "./http.ts";
import type { CloudSession } from "./session-state.ts";

/** A request that will be made, reduced to what the cloud client needs. */
export interface CloudRequestDecision {
  readonly allowed: true;
  readonly method: string;
  /** Path and query on the api origin, for example `/v1/tasks?collection=now`. */
  readonly path: string;
}

/** A request that will not be made, and the reason in a form fit for a log field. */
export interface CloudRequestRefusal {
  readonly allowed: false;
  readonly reason: "url" | "origin" | "path" | "method";
}

/**
 * Whether the renderer may make this request, and the path it becomes. Nothing outside `/v1/` is
 * reachable: the session cookie is scoped to the whole api host, so without the prefix a compromised
 * renderer could aim an authenticated request at `/oauth/`, `/internal/v1/` or a webhook.
 */
export function cloudRequestDecision(input: {
  readonly url: string;
  readonly method: string;
  readonly apiOrigin: string;
}): CloudRequestDecision | CloudRequestRefusal {
  const method = input.method.toUpperCase();
  if (!allowedMethods.includes(method)) return { allowed: false, reason: "method" };
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { allowed: false, reason: "url" };
  }
  if (url.origin !== input.apiOrigin) return { allowed: false, reason: "origin" };
  // `new URL("https://user:pass@api.example/v1/me").origin` is just `https://api.example`, so userinfo
  // survives an origin comparison. The path this function returns drops it, but a caller that smuggled
  // credentials into a URL is not a caller to accommodate.
  if (url.username.length > 0 || url.password.length > 0) {
    return { allowed: false, reason: "origin" };
  }
  if (!url.pathname.startsWith("/v1/")) return { allowed: false, reason: "path" };
  // Rebuilt from the parsed URL rather than sliced out of the input, so a path that only normalises into
  // `/v1/` after the fact cannot be the one that gets sent.
  return { allowed: true, method, path: `${url.pathname}${url.search}` };
}

export interface CloudHandlerOptions {
  readonly apiOrigin: string;
  readonly http: CloudHttp;
  readonly session: CloudSession;
  readonly log: MainLog;
}

/**
 * The handlers behind the cloud channels. They are returned rather than registered so `src/main/ipc.ts`
 * can put them through its own `handle()`, which is where the sender check — top frame, renderer origin —
 * lives; and so this module needs no Electron and unit-tests under plain Node.
 */
export interface CloudHandlers {
  request(payload: unknown): Promise<CloudResponsePayload>;
  abort(requestId: unknown): void;
  /** Aborts everything in flight, for a window that is going away. */
  abortAll(): void;
}

function payloadOf(value: unknown): CloudRequestPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return null;
  if (typeof record.method !== "string" || typeof record.url !== "string") return null;
  if (record.body !== null && typeof record.body !== "string") return null;
  if (!Array.isArray(record.headers)) return null;
  const headers: [string, string][] = [];
  for (const entry of record.headers) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [name, headerValue] = entry as unknown[];
    if (typeof name !== "string" || typeof headerValue !== "string") return null;
    headers.push([name, headerValue]);
  }
  return {
    requestId: record.requestId,
    method: record.method,
    url: record.url,
    headers,
    body: record.body as string | null,
  };
}

export function createCloudHandlers(options: CloudHandlerOptions): CloudHandlers {
  const { log, session } = options;
  const inFlight = new Map<string, AbortController>();

  const request = async (payload: unknown): Promise<CloudResponsePayload> => {
    const parsed = payloadOf(payload);
    if (!parsed) {
      log.warn("cloud.request_malformed");
      throw new CloudRequestRefused("path");
    }
    const decision = cloudRequestDecision({
      url: parsed.url,
      method: parsed.method,
      apiOrigin: options.apiOrigin,
    });
    if (!decision.allowed) {
      // The URL is not logged: it came from the renderer and could carry anything.
      log.warn("cloud.request_refused", { reason: decision.reason });
      throw new CloudRequestRefused(decision.reason === "method" ? "method" : "path");
    }

    const controller = new AbortController();
    inFlight.set(parsed.requestId, controller);
    try {
      const response = await options.http({
        method: decision.method,
        path: decision.path,
        headers: parsed.headers,
        body: parsed.body,
        signal: controller.signal,
      });
      await session.afterResponse(decision.method, decision.path, response);
      return { status: response.status, headers: response.headers, body: response.body };
    } finally {
      inFlight.delete(parsed.requestId);
    }
  };

  const abort = (requestId: unknown): void => {
    if (typeof requestId !== "string") return;
    inFlight.get(requestId)?.abort();
  };

  return {
    request,
    abort,
    abortAll: () => {
      for (const controller of [...inFlight.values()]) controller.abort();
      inFlight.clear();
    },
  };
}
